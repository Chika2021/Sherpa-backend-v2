import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResumeProfile } from '../ai/gemini.service';
import { JobSourceProvider, RawJobListing } from '../jobs/providers/job-source.interface';
import { RemotiveJobSourceProvider } from '../jobs/providers/remotive.provider';
import { RemoteOkJobSourceProvider } from '../jobs/providers/remoteok.provider';
import { ArbeitnowJobSourceProvider } from '../jobs/providers/arbeitnow.provider';
import { JobicyJobSourceProvider } from '../jobs/providers/jobicy.provider';
import { dedupeRawListings, normalizeUrl } from '../jobs/utils/deduplicate-listings';
import { AtsBoardProvider } from './ats-board.provider';
import { ApifyJobSourceProvider } from './apify.provider';
import {
  AiTrainingJob,
  AiTrainingJobsResponse,
  AiTrainingSearchEvent,
  SearchAiTrainingJobsDto,
  SourceAttempt,
} from './dto/search-ai-training-jobs.dto';
import { classifyAiTraining, extractHourlyPay, inferCategory } from './ai-training.classifier';
import { AI_TRAINING_PLATFORMS } from './platforms.catalog';

const FREE_TTL_MS = 10 * 60_000;
const APIFY_TTL_MS = 30 * 60_000; // Apify bills per run, so cache harder
// A source that hasn't answered by then counts as not working and the search moves on.
const TIER_TIMEOUT_MS = 20_000;
const APIFY_TIER_TIMEOUT_MS = 120_000;

// Order sources are tried in. Free public feeds first, the paid Apify scraper last.
// Override with AI_TRAINING_SOURCE_ORDER, e.g. "jobicy,arbeitnow,apify".
const DEFAULT_ORDER = ['arbeitnow', 'jobicy', 'remotive', 'remoteok', 'ats-boards', 'apify'];

interface Tier {
  name: string;
  provider: JobSourceProvider;
  enabled: () => boolean;
  /** Skip the keyword filter: the source is purpose-built for AI-training jobs. */
  trust?: () => boolean;
}

@Injectable()
export class AiTrainingJobsService {
  private readonly logger = new Logger(AiTrainingJobsService.name);
  private readonly chain: Tier[];
  private readonly cache = new Map<string, { at: number; jobs: AiTrainingJob[] }>();
  private readonly inFlight = new Map<string, Promise<AiTrainingJob[]>>();

  constructor(
    config: ConfigService,
    remotive: RemotiveJobSourceProvider,
    remoteOk: RemoteOkJobSourceProvider,
    arbeitnow: ArbeitnowJobSourceProvider,
    jobicy: JobicyJobSourceProvider,
    ats: AtsBoardProvider,
    private readonly apify: ApifyJobSourceProvider,
  ) {
    const all: Record<string, Tier> = {
      arbeitnow: { name: 'arbeitnow', provider: arbeitnow, enabled: () => true },
      jobicy: { name: 'jobicy', provider: jobicy, enabled: () => true },
      remotive: { name: 'remotive', provider: remotive, enabled: () => true },
      remoteok: { name: 'remoteok', provider: remoteOk, enabled: () => true },
      'ats-boards': { name: 'ats-boards', provider: ats, enabled: () => true },
      apify: { name: 'apify', provider: apify, enabled: () => apify.isEnabled(), trust: () => apify.trustResults },
    };
    const order = (config.get<string>('AI_TRAINING_SOURCE_ORDER') || DEFAULT_ORDER.join(','))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => all[s]);
    this.chain = (order.length ? order : DEFAULT_ORDER).map((n) => all[n]);
    this.logger.log(`AI training source order: ${this.chain.map((t) => t.name).join(' -> ')}`);
  }

  platforms() {
    return AI_TRAINING_PLATFORMS;
  }

  /**
   * Walks the source chain in order and stops as soon as it has enough matching
   * roles for the requested page (offset + limit). If a source has nothing - or
   * not enough - the search falls through to the next one, so a user still gets
   * AI-training jobs when one platform comes up empty. Asking for more
   * (a larger offset) resumes down the chain.
   */
  async search(dto: SearchAiTrainingJobsDto): Promise<AiTrainingJobsResponse> {
    let result: AiTrainingJobsResponse | undefined;
    for await (const event of this.searchStream(dto)) {
      if (event.type === 'done') result = event.result;
    }
    return result!;
  }

  /** Same search as `search()`, but reports each step so the UI can show which source is running. */
  async *searchStream(dto: SearchAiTrainingJobsDto): AsyncGenerator<AiTrainingSearchEvent> {
    const limit = dto.limit ?? 20;
    const offset = dto.offset ?? 0;
    const need = offset + limit;
    const q = dto.q?.trim();

    const gathered: AiTrainingJob[] = [];
    const seen = new Set<string>();
    const attempts: SourceAttempt[] = [];
    let stoppedEarly = false;

    const chain = dto.source ? this.chain.filter((t) => tierMatches(t.name, dto.source!)) : this.chain;
    const active = chain.filter((t) => t.enabled());
    yield { type: 'start', sources: active.map((t) => t.name) };

    let step = 0;
    for (let i = 0; i < chain.length; i++) {
      const tier = chain[i];
      if (!tier.enabled()) {
        attempts.push({ source: tier.name, found: 0, status: 'skipped', note: 'not configured' });
        continue;
      }

      step++;
      yield { type: 'trying', source: tier.name, step, of: active.length };

      let attempt: SourceAttempt;
      try {
        const timeout = tier.name === 'apify' ? APIFY_TIER_TIMEOUT_MS : TIER_TIMEOUT_MS;
        const jobs = await withTimeout(this.getSourceJobs(tier, q), timeout, `${tier.name} did not respond in time`);
        let added = 0;
        for (const j of jobs) {
          if (!matches(j, dto, q)) continue;
          const key = normalizeUrl(j.applyUrl);
          if (seen.has(key)) continue;
          seen.add(key);
          gathered.push(j);
          added++;
        }
        attempt = { source: tier.name, found: added, status: 'ok' };
      } catch (err) {
        this.logger.warn(`${tier.name} failed: ${(err as Error).message}`);
        attempt = { source: tier.name, found: 0, status: 'error', note: (err as Error).message.slice(0, 160) };
      }
      attempts.push(attempt);
      yield { type: 'attempt', attempt, gathered: gathered.length };

      if (gathered.length >= need) {
        // Enough for this page: leave remaining sources for a later "show more".
        stoppedEarly = chain.slice(i + 1).some((t) => t.enabled());
        break;
      }
    }

    yield {
      type: 'done',
      result: {
        total: gathered.length,
        hasMore: gathered.length > need || stoppedEarly,
        attempts,
        limit,
        offset,
        jobs: gathered.slice(offset, offset + limit),
        sources: attempts.filter((a) => a.found > 0).map((a) => a.source),
      },
    };
  }

  private getSourceJobs(tier: Tier, q?: string): Promise<AiTrainingJob[]> {
    const isApify = tier.name === 'apify';
    // Free feeds are fetched whole and filtered here; Apify is query-specific.
    const key = isApify ? `apify:${(q || '').toLowerCase()}` : tier.name;
    const ttl = isApify ? APIFY_TTL_MS : FREE_TTL_MS;

    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.jobs);
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const p = this.fetchAndClassify(tier, isApify ? q : undefined)
      .then((jobs) => {
        this.cache.set(key, { at: Date.now(), jobs });
        return jobs;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async fetchAndClassify(tier: Tier, query?: string): Promise<AiTrainingJob[]> {
    const raw: RawJobListing[] = await tier.provider.search({} as ResumeProfile, { query, limit: 250 });
    const jobs: AiTrainingJob[] = [];
    const rejected: string[] = [];
    for (const r of dedupeRawListings(raw)) {
      let cls = classifyAiTraining(r.title, r.description || '');
      if (!cls && tier.trust?.()) cls = { category: inferCategory(r.title, r.description || ''), score: 1 };
      if (!cls || !r.applyUrl) {
        if (rejected.length < 5) rejected.push(r.title);
        continue;
      }
      const pay = extractHourlyPay(`${r.salary || ''} ${r.description || ''}`);
      jobs.push({
        id: `${r.source}:${r.externalId ?? r.applyUrl}`,
        source: r.source,
        title: r.title,
        company: r.company,
        category: cls.category,
        location: r.location,
        remote: r.isRemote ?? /remote|worldwide|anywhere/i.test(r.location || ''),
        employmentType: r.jobType,
        summary: (r.description || '').slice(0, 400),
        applyUrl: r.applyUrl,
        postedAt: r.postedAt?.toISOString(),
        pay: pay.min !== undefined ? { ...pay, unit: 'HOUR' } : r.salary ? { text: r.salary, unit: 'UNKNOWN' } : undefined,
      });
    }
    jobs.sort((a, b) => Date.parse(b.postedAt || '0') - Date.parse(a.postedAt || '0'));
    this.logger.log(`${tier.name}: ${raw.length} listing(s) fetched, ${jobs.length} look like AI-training work.`);
    if (!jobs.length && rejected.length) {
      this.logger.log(`${tier.name}: example titles that were filtered out: ${rejected.map((t) => `"${t}"`).join(', ')}`);
    }
    return jobs;
  }
}

function tierMatches(tierName: string, source: string): boolean {
  const s = source.toLowerCase();
  return tierName === s || (tierName === 'ats-boards' && /^(greenhouse|lever|ashby)/.test(s));
}

function matches(j: AiTrainingJob, dto: SearchAiTrainingJobsDto, q?: string): boolean {
  if (dto.category && j.category !== dto.category) return false;
  if (dto.remote && !j.remote) return false;
  if (dto.source && !j.source.startsWith(dto.source)) return false;
  if (q && !`${j.title} ${j.company || ''} ${j.summary}`.toLowerCase().includes(q.toLowerCase())) return false;
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
