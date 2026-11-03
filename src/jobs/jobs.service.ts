import { BadRequestException, Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AiJobResult, GeminiService, JobCandidateForRanking, ResumeProfile } from '../ai/gemini.service';
import { ResumesService } from '../resumes/resumes.service';
import { SearchJobsDto } from './dto/search-jobs.dto';
import { Job } from '../entities/job.entity';
import { JobSearch } from '../entities/job-search.entity';
import { JobSearchResult } from '../entities/job-search-result.entity';
import { SavedJob } from '../entities/saved-job.entity';
import { JobType } from '../entities/enums';
import { assertValidId, isUuid, ownedBy } from '../database/db-utils';
import { upsertJob } from './utils/upsert-job';
import { JobSourceProvider, RawJobListing } from './providers/job-source.interface';
import { RemotiveJobSourceProvider } from './providers/remotive.provider';
import { RemoteOkJobSourceProvider } from './providers/remoteok.provider';
import { ArbeitnowJobSourceProvider } from './providers/arbeitnow.provider';
import { JobicyJobSourceProvider } from './providers/jobicy.provider';
import { AdzunaJobSourceProvider } from './providers/adzuna.provider';
import { WeAreDevelopersJobSourceProvider } from './providers/wearedevelopers.provider';
import { ContraJobSourceProvider } from './providers/contra.provider';
import { dedupeRawListings, findDuplicateJob } from './utils/deduplicate-listings';
import { JobSourceSettingsService } from '../job-sources/job-source-settings.service';

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  // Real job-board sources, checked before ever calling the AI. Several
  // independent APIs/scrapers so one being unreachable (network policy,
  // regional block, temporary outage, a site changing its markup) doesn't
  // take job search down with it, and so coverage isn't limited to whatever
  // one board happens to list. Add more JobSourceProvider implementations
  // here (see providers/job-source.interface.ts, or extend
  // providers/base-job-scraper.ts for the fetch/normalize pattern most of
  // these follow) to widen coverage further.
  //  - remotive/remoteok/arbeitnow/jobicy: free public JSON APIs, always on.
  //  - adzuna: broader API that needs a free key; contributes nothing until
  //    configured (see adzuna.provider.ts).
  //  - weAreDevelopers/contra: scraped via fetch + Cheerio (no browser) -
  //    both sites render client-side in JS, so these only return listings
  //    present in the raw HTML (server-rendered cards / JSON-LD).
  // If every source here comes back empty for a given search, `search()`
  // below falls back to having the AI look for real postings on the live
  // web itself - see GeminiService.searchJobsOnWeb.
  private readonly sources: JobSourceProvider[];

  constructor(
    @InjectRepository(Job) private jobs: Repository<Job>,
    @InjectRepository(JobSearch) private jobSearches: Repository<JobSearch>,
    @InjectRepository(JobSearchResult) private jobSearchResults: Repository<JobSearchResult>,
    @InjectRepository(SavedJob) private savedJobs: Repository<SavedJob>,
    private gemini: GeminiService,
    private resumesService: ResumesService,
    remotive: RemotiveJobSourceProvider,
    remoteok: RemoteOkJobSourceProvider,
    arbeitnow: ArbeitnowJobSourceProvider,
    jobicy: JobicyJobSourceProvider,
    adzuna: AdzunaJobSourceProvider,
    private moduleRef: ModuleRef,
    contra: ContraJobSourceProvider,
    private jobSourceSettings: JobSourceSettingsService,
  ) {
    this.sources = [
      remotive,
      remoteok,
      arbeitnow,
      jobicy,
      adzuna,
      contra,
    ];
  }

  /**
   * Runs a job search for the user: pulls their (chosen or primary) resume
   * profile, finds matching postings, and persists + returns the ranked list.
   *
   * Results always come from real postings, never invented ones, EXCEPT for
   * one clearly-flagged edge case: if Gemini itself is unavailable (quota,
   * outage) when the AI web search fallback runs, GeminiService.searchJobsOnWeb
   * hands off to Cerebras, which has no live web access to verify a URL
   * against - those listings are tagged source: 'ai-web-search-unverified'
   * (vs the normal 'ai-web-search') precisely because they're AI-suggested
   * rather than search-confirmed, same honesty as 'gemini-suggested' below.
   * Otherwise:
   *  - Every `applyUrl` returned is a real link - to the actual job site
   *    from a board API, or to the exact page Google Search found it on -
   *    never a fabricated one or a bare search-engine query.
   *  - Every board-API listing has passed that source's freshness filter
   *    (see MAX_LISTING_AGE_DAYS in job-source.interface.ts), so results are
   *    restricted to postings that are still recent enough to be actively
   *    recruiting, not stale reposts. (The AI web search fallback relies on
   *    Google Search itself for currency rather than a hard cutoff.)
   *  - If every real board source AND the AI web search fallback (Gemini and
   *    its own Cerebras fallback) come back empty, the search legitimately
   *    returns zero results rather than inventing plausible-sounding jobs.
   * On real board listings, AI is only used to score/explain fit
   * (GeminiService.rankJobMatches - small prompt, no search-grounding tool).
   * If that AI call fails for any reason (quota, network, malformed JSON),
   * local keyword ranking (naiveRank) takes over so the search still returns
   * its real results.
   */
  async search(userId: string, dto: SearchJobsDto) {
    const resume = dto.resumeId
      ? await this.resumesService.findOne(userId, dto.resumeId)
      : await this.resumesService.getPrimary(userId);

    const profile = resume.parsedProfile as any;
    const criteria = { query: dto.query, jobTypes: dto.jobTypes, location: dto.location, limit: dto.limit };
    const limit = Math.min(criteria.limit ?? 10, 50);

    if (dto.source && !this.sources.some((s) => s.name === dto.source)) {
      throw new BadRequestException(
        `Unknown job source "${dto.source}". Valid sources: ${this.sources.map((s) => s.name).join(', ')}.`,
      );
    }

    const rawListings = await this.collectRealListings(profile, criteria, dto.source);
    let aiResults: AiJobResult[] =
      rawListings.length > 0 ? await this.rankRealListings(userId, profile, criteria, rawListings, limit) : [];

    // Real board APIs (this.sources) came back completely empty - most often
    // because Adzuna (by far the broadest of them) is deactivated/unconfigured
    // and the remaining boards don't cover this query/location either. Rather
    // than stop at "no matches", let the AI search the live web itself
    // (Gemini + Google Search grounding) for real, currently-open postings.
    // See GeminiService.searchJobsOnWeb for why this is a *fallback*, not
    // just another entry in this.sources: it needs userId for billing, and
    // grounding draws from a separate/smaller quota so it's only worth
    // spending when nothing else found anything. Best-effort - if it also
    // comes back empty or fails, search still legitimately returns zero
    // results rather than erroring.
    // A search restricted to one named source (the "Search source" filter in
    // the UI, e.g. "Adzuna") should honestly report zero results when that
    // one source has nothing, not silently backfill with AI-suggested
    // listings from a completely different, unverified source under that
    // filter - so this fallback only runs for an unrestricted search.
    if (aiResults.length === 0 && !dto.source) {
      try {
        const webResults = await this.gemini.searchJobsOnWeb(userId, profile, criteria);
        if (webResults.length > 0) {
          this.logger.log(`Real job-board sources returned nothing; AI web search found ${webResults.length} listing(s).`);
          aiResults = webResults.sort((a, b) => b.matchScore - a.matchScore).slice(0, limit);
        }
      } catch (err) {
        this.logger.warn(`AI web job search fallback failed, no results: ${(err as Error).message}`);
      }
    }

    assertValidId(userId, 'User');
    const jobSearch = await this.jobSearches.save(
      this.jobSearches.create({
        userId,
        query: dto.query,
        jobTypes: (dto.jobTypes as any) || [],
        location: dto.location,
        resumeId: resume.id,
      }),
    );

    const savedResults: any[] = [];
    for (let i = 0; i < aiResults.length; i++) {
      const r = aiResults[i];
      const jobType = this.normalizeJobType(r.jobType);
      const source = r.source || 'gemini';

      // Same-source, same-listing upsert (below) already prevents refetching
      // this exact posting from creating a second row. What it can't catch
      // is the SAME real-world opening surfaced by a DIFFERENT source (or by
      // this same source under a different tracking URL) - check for that
      // before creating a new document. Skipped entirely for a listing that
      // already has a matching row under this exact (source, applyUrl) key,
      // since that case is a legitimate refresh, not a duplicate.
      // (A listing with no apply URL can't be stored or applied to - skip it.)
      if (!r.applyUrl || !r.title) {
        this.logger.warn(`Skipping a listing with no ${!r.applyUrl ? 'apply URL' : 'title'} from "${source}".`);
        continue;
      }
      const hasExactRow =
        (await this.jobs.count({ where: { source, externalId: r.applyUrl, applyUrl: r.applyUrl } })) > 0;
      let job: Job | null = null;
      if (!hasExactRow) {
        job = await findDuplicateJob(
          this.jobs,
          {
            source,
            applyUrl: r.applyUrl,
            title: r.title,
            company: r.company,
            jobType,
            description: r.description,
          },
          // A search restricted to one named source (dto.source) should only
          // be suppressed by a duplicate from THAT source - a match from a
          // different source is irrelevant to someone who explicitly asked
          // to see just this one's results (see findDuplicateJob for why).
          dto.source ? { restrictToSource: dto.source } : undefined,
        );
        if (job) {
          // IMPORTANT: a duplicate still means a real, relevant job exists -
          // it just doesn't need a second row. Previously this branch did
          // `continue` here, which dropped the ranked listing from this
          // search's results entirely (see the bug this fixes: a
          // source-restricted search whose only AI-ranked hit turned out to
          // already be saved would come back with zero results, even though
          // a matching job genuinely existed). Instead, attach THIS search
          // to the existing job below so it still shows up, without
          // creating a duplicate document.
          this.logger.debug(
            `"${r.title}" at "${r.company}" from "${source}" matches an existing listing (source: "${job.source}") - reusing it instead of creating a duplicate row.`,
          );
        }
      }

      if (!job) {
        job = await upsertJob(
          this.jobs,
          { source, externalId: r.applyUrl, applyUrl: r.applyUrl },
          {
            title: r.title,
            company: r.company,
            companyLogoUrl: r.companyLogoUrl,
            location: r.location,
            jobType,
            description: r.description,
            salary: r.salary,
            salaryMin: r.salaryMin,
            salaryMax: r.salaryMax,
            salaryCurrency: r.salaryCurrency,
            isRemote: r.isRemote,
            workSchedule: r.workSchedule,
            raw: r as any,
          },
        );
      }

      await this.jobSearchResults.upsert(
        { jobSearchId: jobSearch.id, jobId: job.id, matchScore: r.matchScore, matchReason: r.matchReason, rank: i + 1 },
        ['jobSearchId', 'jobId'],
      );
      const result = await this.jobSearchResults.findOneByOrFail({ jobSearchId: jobSearch.id, jobId: job.id });

      savedResults.push({ ...job.toJSON(), matchScore: result.matchScore, matchReason: result.matchReason });
    }

    return {
      jobSearchId: jobSearch.id,
      count: savedResults.length,
      // Which AI handled this request (e.g. "Currently answering with Gemini (gemini-3.1-flash-lite).")
      ai: this.gemini.getAiStatus().message,
      results: savedResults,
      ...(savedResults.length === 0 && {
        message:
          'No actively-recruiting postings matched your search right now. Try a broader query, a different location, or fewer job type filters.',
      }),
    };
  }

  async getSearch(userId: string, jobSearchId: string): Promise<Record<string, any>> {
    const search = await this.jobSearches.findOneBy(ownedBy(jobSearchId, userId, 'Job search'));
    if (!search) throw new NotFoundException('Job search not found');

    const results = await this.jobSearchResults.find({
      where: { jobSearchId: search.id },
      relations: { job: true },
      order: { rank: 'ASC' },
    });

    return { ...search.toJSON(), results };
  }

  async getJob(id: string) {
    assertValidId(id, 'Job');
    const job = await this.jobs.findOneBy({ id });
    if (!job) throw new NotFoundException('Job not found');
    return job;
  }

  async saveJob(userId: string, jobId: string) {
    await this.getJob(jobId);
    assertValidId(userId, 'User');
    // Insert only if this user hasn't saved the job yet (unique on userId + jobId); either way return the row.
    await this.savedJobs.createQueryBuilder().insert().values({ userId, jobId }).orIgnore().execute();
    return this.savedJobs.findOneByOrFail({ userId, jobId });
  }

  async unsaveJob(userId: string, jobId: string) {
    // Same shape the endpoint has always returned ({ acknowledged, deletedCount }).
    if (!isUuid(userId) || !isUuid(jobId)) return { acknowledged: true, deletedCount: 0 };
    const result = await this.savedJobs.delete({ userId, jobId });
    return { acknowledged: true, deletedCount: result.affected ?? 0 };
  }

  async listSaved(userId: string) {
    assertValidId(userId, 'User');
    const saved = await this.savedJobs.find({
      where: { userId },
      relations: { job: true },
      order: { createdAt: 'DESC' },
    });
    // Guard against an orphaned entry (its Job record no longer resolving) so
    // the frontend never has to render a saved item with job: null.
    return saved.filter((s) => s.job);
  }

  /**
   * Queries every registered real job-board source and pools their results.
   * One slow/failing source never blocks the others. Gated sources (Adzuna,
   * WeAreDevelopers, arc.dev - see JobSourceSettingsService) are checked
   * against the PERSISTED settings document on every call, never against
   * process.env, so a toggle flip is live on the very next search; a
   * disabled provider is skipped entirely and never has its search() method
   * called at all.
   */
  private async collectRealListings(
    profile: ResumeProfile,
    criteria: { query?: string; jobTypes?: string[]; location?: string; limit?: number },
    sourceFilter?: string,
  ): Promise<RawJobListing[]> {
    const sourceSettings = await this.jobSourceSettings.getSettings();
    const candidates = sourceFilter ? this.sources.filter((s) => s.name === sourceFilter) : this.sources;
    const perSource = await Promise.all(
      candidates.map(async (source) => {
        if (!this.jobSourceSettings.isEnabled(source.name, sourceSettings)) {
          this.logger.log(`Job source "${source.name}" is disabled in job-source settings - skipping.`);
          return [];
        }
        try {
          return await source.search(profile, criteria);
        } catch (err) {
          this.logger.warn(`Job source "${source.name}" failed, skipping it: ${(err as Error).message}`);
          return [];
        }
      }),
    );
    // Freshest first across ALL sources combined, so when there are more raw
    // listings than we need, the ones we actually rank/return are the latest -
    // each source already filters out anything past MAX_LISTING_AGE_DAYS.
    const pooled = perSource.flat().sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0));
    // The SAME real-world opening frequently appears on more than one
    // platform (e.g. cross-posted to both 4dayweek.io and web3.career, or
    // aggregated by Adzuna from a company site AND separately picked up by
    // one of our own scrapers) - collapse those before ranking/saving so the
    // user never sees the same job twice. Each individual source has
    // already deduped its OWN internal duplicates (see BaseJobScraper); this
    // is the cross-source pass.
    const deduped = dedupeRawListings(pooled);
    // Guarantee every listing has enough real, job-specific context for the
    // AI to write a competent, non-generic tailored resume and cover letter
    // from it - see ensureDescription for why this is needed.
    return deduped.map((listing) => ({ ...listing, description: this.ensureDescription(listing) }));
  }

  /**
   * Some sources occasionally hand back an empty or near-empty description
   * (a listing with no body text, or one the source's own API just didn't
   * populate) - every provider falls back to '' in that case rather than
   * fabricating content. Left as-is, that produces a prompt like "TARGET
   * JOB: Title: X Company: Y Description:" with nothing concrete after it,
   * which tends to make generateTailoredResume/generateCoverLetter fall back
   * to generic filler instead of something that actually references the
   * role. This builds a short, factual summary from the fields the listing
   * DOES have (title, company, location, job type, salary) so there is
   * always something real to write from, while leaving genuinely-described
   * listings untouched.
   */
  private ensureDescription(listing: RawJobListing): string {
    const MIN_USEFUL_LENGTH = 60;
    const original = listing.description?.trim() ?? '';
    if (original.length >= MIN_USEFUL_LENGTH) return listing.description;

    const typeLabel =
      listing.jobType && listing.jobType !== 'CUSTOM' ? listing.jobType.replace('_', ' ').toLowerCase() : '';
    const parts: string[] = [
      `${typeLabel ? `A ${typeLabel} ` : 'A '}${listing.title} position` +
        `${listing.company ? ` at ${listing.company}` : ''}${listing.location ? `, based in ${listing.location}` : ''}.`,
    ];
    if (listing.salary) parts.push(`Salary: ${listing.salary}.`);
    if (original) parts.push(original);
    parts.push('(This posting did not include a full description - refer to the original listing for complete requirements.)');
    return parts.join(' ');
  }

  /**
   * Scores real listings against the candidate. Tries the lightweight AI
   * ranker first; if it throws for ANY reason (quota, network, malformed
   * JSON), falls back to local keyword ranking so a real search never comes
   * back empty just because the AI call failed.
   */
  private async rankRealListings(
    userId: string,
    profile: ResumeProfile,
    criteria: { query?: string; jobTypes?: string[]; location?: string },
    rawListings: RawJobListing[],
    limit: number,
  ): Promise<AiJobResult[]> {
    // Never hand the model more candidates than it needs to fill the request -
    // keeps the prompt small regardless of how many real listings came back.
    const candidates = rawListings.slice(0, Math.max(limit * 3, 30));

    try {
      const forRanking: JobCandidateForRanking[] = candidates.map((c, index) => ({
        index,
        title: c.title,
        company: c.company,
        location: c.location,
        jobType: c.jobType,
        snippet: c.description.slice(0, 220),
      }));
      const rankings = await this.gemini.rankJobMatches(userId, profile, criteria, forRanking);
      const byIndex = new Map(rankings.map((r) => [r.index, r]));

      return candidates
        .map((c, index) => {
          const r = byIndex.get(index);
          return this.toAiJobResult(c, r?.matchScore ?? 50, r?.matchReason ?? 'Matches your search filters.');
        })
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, limit);
    } catch (err) {
      this.logger.warn(`AI job ranking unavailable, trying WeAreDevelopers fallback: ${(err as Error).message}`);
      try {
        const sourceSettings = await this.jobSourceSettings.getSettings();
        const weAreDevelopers = sourceSettings.weAreDevelopersEnabled
          ? this.moduleRef.get(WeAreDevelopersJobSourceProvider, { strict: false })
          : null;
        if (!sourceSettings.weAreDevelopersEnabled) {
          this.logger.log('WeAreDevelopers is disabled in job-source settings - skipping fallback.');
        }
        if (weAreDevelopers) {
          const weAreDevelopersListings = await weAreDevelopers.search(profile, criteria);
          if (weAreDevelopersListings.length > 0) {
            const withDescriptions = weAreDevelopersListings.map((l) => ({
              ...l,
              description: this.ensureDescription(l),
            }));
            this.logger.log(
              `WeAreDevelopers fallback returned ${withDescriptions.length} listing(s) after AI rankers failed.`,
            );
            return this.naiveRank(profile, criteria, withDescriptions, limit);
          }
        }
      } catch (weErr) {
        this.logger.warn(`WeAreDevelopers fallback also failed: ${(weErr as Error).message}`);
      }

      this.logger.warn('Falling back to local keyword ranking over collected listings.');
      return this.naiveRank(profile, criteria, candidates, limit);
    }
  }

  /** No-AI fallback: scores real listings by simple skill/query keyword overlap. Always available. */
  private naiveRank(
    profile: ResumeProfile,
    criteria: { query?: string },
    candidates: RawJobListing[],
    limit: number,
  ): AiJobResult[] {
    const skills = (profile?.skills || []).map((s) => s.toLowerCase()).filter(Boolean);
    const queryTerms = (criteria.query || '').toLowerCase().split(/\s+/).filter(Boolean);

    return candidates
      .map((c) => {
        const haystack = `${c.title} ${c.description}`.toLowerCase();
        const matchedSkills = skills.filter((s) => haystack.includes(s));
        const queryHits = queryTerms.filter((q) => haystack.includes(q));
        const matchScore = Math.min(100, 20 + matchedSkills.length * 12 + queryHits.length * 15);

        const reasonParts: string[] = [];
        if (matchedSkills.length) reasonParts.push(`matches your skills in ${matchedSkills.slice(0, 3).join(', ')}`);
        if (queryHits.length) reasonParts.push('matches your search terms');
        const matchReason = reasonParts.length ? `${capitalize(reasonParts.join('; '))}.` : 'Matches your search filters.';

        return this.toAiJobResult(c, matchScore, matchReason);
      })
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limit);
  }

  private toAiJobResult(c: RawJobListing, matchScore: number, matchReason: string): AiJobResult {
    return {
      title: c.title,
      company: c.company || 'Unknown company',
      companyLogoUrl: c.companyLogoUrl,
      location: c.location,
      jobType: c.jobType,
      description: c.description,
      applyUrl: c.applyUrl,
      salary: c.salary,
      salaryMin: c.salaryMin,
      salaryMax: c.salaryMax,
      salaryCurrency: c.salaryCurrency,
      isRemote: c.isRemote,
      workSchedule: c.workSchedule,
      matchScore,
      matchReason,
      source: c.source,
    };
  }

  private normalizeJobType(value: string): JobType {
    const allowed = [
      'FULL_TIME',
      'PART_TIME',
      'REMOTE',
      'FREELANCE',
      'ONLINE',
      'CONTRACT',
      'INTERNSHIP',
      'CUSTOM',
    ];
    const upper = (value || '').toUpperCase().replace(/[\s-]/g, '_');
    return (allowed.includes(upper) ? upper : 'CUSTOM') as JobType;
  }
}

function capitalize(text: string): string {
  return text.length ? text[0].toUpperCase() + text.slice(1) : text;
}