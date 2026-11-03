import { Injectable, Logger } from '@nestjs/common';
import { JobSourceProvider, JobSourceCriteria, RawJobListing, MAX_LISTING_AGE_DAYS } from './job-source.interface';
import { ResumeProfile } from '../../ai/gemini.service';
import { fetchJsonWithRetry } from './fetch-with-diagnostics';

const REMOTIVE_URL = 'https://remotive.com/api/remote-jobs';

// Remotive's own docs ask API consumers to fetch at most ~4 times a day ("our
// data is not changing much faster than that anyway") and say they'll block
// callers who exceed 2 requests/minute. A 20-minute in-process cache keeps us
// comfortably under both limits no matter how many users search in that
// window, while still feeling fresh to any one user.
const CACHE_TTL_MS = 20 * 60_000;
// Remotive has no server-side limit param beyond a flat cap; pulling a wide
// slice once per cache window and filtering in memory is far cheaper than
// round-tripping per search.
const FEED_SIZE = 250;

interface RemotiveJob {
  id: number;
  url: string;
  title: string;
  company_name: string;
  category?: string;
  job_type?: string; // full_time/contract/part_time/freelance/internship - optional, often blank
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description: string; // HTML
}

const JOB_TYPE_MAP: Record<string, string> = {
  full_time: 'FULL_TIME',
  part_time: 'PART_TIME',
  contract: 'CONTRACT',
  freelance: 'FREELANCE',
  internship: 'INTERNSHIP',
};

/**
 * Pulls real, currently-open remote job postings from Remotive's free public
 * JSON API (https://remotive.com/api/remote-jobs) - no API key, no LLM call,
 * no chance of a Gemini quota/credit error. This is what makes job search
 * work even when the AI provider is unavailable: JobsService ranks these
 * real listings with a lightweight AI call when it can, and falls back to
 * local keyword ranking when it can't (see JobsService.naiveRank).
 *
 * Attribution note: Remotive's terms ask that published uses link back to
 * the listing's own `url` and credit Remotive as the source. Every listing
 * below keeps its original `url` in `raw.remotiveUrl` for that purpose -
 * don't drop it if you build a UI on top of this.
 */
@Injectable()
export class RemotiveJobSourceProvider implements JobSourceProvider {
  name = 'remotive';
  private readonly logger = new Logger(RemotiveJobSourceProvider.name);
  private cache: { fetchedAt: number; jobs: RemotiveJob[] } | null = null;
  private inFlight: Promise<RemotiveJob[]> | null = null;

  async search(_profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    const jobs = await this.getFeed();
    return this.filter(jobs, criteria).map((j) => this.toRawListing(j));
  }

  private async getFeed(): Promise<RemotiveJob[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache.jobs;
    // De-dupe concurrent cache misses (e.g. several users searching at once
    // right after startup) into a single outbound request instead of one each.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchFeed()
      .then((jobs) => {
        this.cache = { fetchedAt: Date.now(), jobs };
        return jobs;
      })
      .catch((err) => {
        const reason = (err as Error).message;
        if (this.cache) {
          this.logger.warn(`Remotive fetch failed (${reason}); serving previously cached listings instead.`);
          return this.cache.jobs;
        }
        this.logger.warn(`Remotive fetch failed (${reason}); no cached listings available.`);
        return [];
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchFeed(): Promise<RemotiveJob[]> {
    const body = await fetchJsonWithRetry<{ jobs?: RemotiveJob[] }>(`${REMOTIVE_URL}?limit=${FEED_SIZE}`, {
      label: 'Remotive',
      init: { headers: { 'User-Agent': 'job-apply-backend (+https://remotive.com/api/remote-jobs terms honored)' } },
    });
    return Array.isArray(body?.jobs) ? body.jobs : [];
  }

  private filter(jobs: RemotiveJob[], criteria: JobSourceCriteria): RemotiveJob[] {
    const query = criteria.query?.toLowerCase().trim();
    const location = criteria.location?.toLowerCase().trim();
    const wantedTypes = new Set(
      (criteria.jobTypes || [])
        .map((t) => t.toUpperCase())
        .filter((t) => Object.values(JOB_TYPE_MAP).includes(t) || t === 'REMOTE'),
    );
    const oldestAllowed = Date.now() - MAX_LISTING_AGE_DAYS * 24 * 60 * 60_000;

    return jobs.filter((j) => {
      // "Actively recruiting" is best approximated by recency: Remotive
      // doesn't expose a separate open/closed flag, but a listing published
      // within the last MAX_LISTING_AGE_DAYS is a reasonable proxy for
      // "still hiring", and anything older is far more likely stale/filled.
      const publishedAt = j.publication_date ? Date.parse(j.publication_date) : NaN;
      if (Number.isNaN(publishedAt) || publishedAt < oldestAllowed) return false;

      if (query) {
        const haystack = `${j.title} ${j.company_name} ${j.category || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      if (location && !(j.candidate_required_location || '').toLowerCase().includes(location)) {
        // "Worldwide" postings match any location preference - it's not a
        // geographic restriction, it's an absence of one.
        if (!(j.candidate_required_location || '').toLowerCase().includes('worldwide')) return false;
      }
      if (wantedTypes.size && !wantedTypes.has('REMOTE')) {
        const mapped = JOB_TYPE_MAP[(j.job_type || '').toLowerCase()];
        if (!mapped || !wantedTypes.has(mapped)) return false;
      }
      return true;
    })
      .sort((a, b) => Date.parse(b.publication_date || '') - Date.parse(a.publication_date || ''));
  }

  private toRawListing(j: RemotiveJob): RawJobListing {
    return {
      source: 'remotive',
      externalId: String(j.id),
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      jobType: JOB_TYPE_MAP[(j.job_type || '').toLowerCase()] || 'REMOTE',
      description: truncate(stripHtml(j.description), 900),
      applyUrl: j.url,
      salary: j.salary || undefined,
      postedAt: j.publication_date ? new Date(j.publication_date) : undefined,
      raw: { remotiveId: j.id, remotiveUrl: j.url, category: j.category },
    };
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
