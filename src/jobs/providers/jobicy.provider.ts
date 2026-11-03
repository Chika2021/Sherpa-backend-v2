import { Injectable, Logger } from '@nestjs/common';
import { JobSourceProvider, JobSourceCriteria, RawJobListing, MAX_LISTING_AGE_DAYS } from './job-source.interface';
import { ResumeProfile } from '../../ai/gemini.service';
import { fetchJsonWithRetry } from './fetch-with-diagnostics';

const JOBICY_URL = 'https://jobicy.com/api/v2/remote-jobs';
const CACHE_TTL_MS = 20 * 60_000;
// Jobicy hard-caps a single response at 100 jobs - this is a current-feed
// snapshot, not something to paginate further.
const FEED_SIZE = 100;

interface JobicyJob {
  id: number;
  url: string;
  jobSlug?: string;
  jobTitle: string;
  companyName?: string;
  jobIndustry?: string | string[];
  jobType?: string | string[]; // e.g. "Full-Time" - sometimes array, sometimes comma-joined string
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string; // HTML
  pubDate?: string; // ISO 8601
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: string;
}

const JOB_TYPE_MAP: Record<string, string> = {
  'full-time': 'FULL_TIME',
  'part-time': 'PART_TIME',
  contract: 'CONTRACT',
  freelance: 'FREELANCE',
  internship: 'INTERNSHIP',
};

/**
 * Pulls real, currently-open remote postings from Jobicy's free public JSON
 * API v2 (https://jobicy.com/api/v2/remote-jobs) - no API key, no LLM call.
 * A different curation/company mix than Remotive/RemoteOK, so it widens
 * coverage rather than mostly duplicating them.
 *
 * Attribution note: Jobicy's API notice asks published uses to credit
 * Jobicy with a direct link and keep "apply" pointed at the original `url` -
 * kept in `raw.jobicyUrl` on every listing.
 */
@Injectable()
export class JobicyJobSourceProvider implements JobSourceProvider {
  name = 'jobicy';
  private readonly logger = new Logger(JobicyJobSourceProvider.name);
  private cache: { fetchedAt: number; jobs: JobicyJob[] } | null = null;
  private inFlight: Promise<JobicyJob[]> | null = null;

  async search(_profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    const jobs = await this.getFeed();
    return this.filter(jobs, criteria).map((j) => this.toRawListing(j));
  }

  private async getFeed(): Promise<JobicyJob[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache.jobs;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchFeed()
      .then((jobs) => {
        this.cache = { fetchedAt: Date.now(), jobs };
        return jobs;
      })
      .catch((err) => {
        const reason = (err as Error).message;
        if (this.cache) {
          this.logger.warn(`Jobicy fetch failed (${reason}); serving previously cached listings instead.`);
          return this.cache.jobs;
        }
        this.logger.warn(`Jobicy fetch failed (${reason}); no cached listings available.`);
        return [];
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchFeed(): Promise<JobicyJob[]> {
    const body = await fetchJsonWithRetry<{ jobs?: JobicyJob[] }>(`${JOBICY_URL}?count=${FEED_SIZE}`, {
      label: 'Jobicy',
    });
    return Array.isArray(body?.jobs) ? body.jobs : [];
  }

  private filter(jobs: JobicyJob[], criteria: JobSourceCriteria): JobicyJob[] {
    const query = criteria.query?.toLowerCase().trim();
    const location = criteria.location?.toLowerCase().trim();
    // Jobicy is a remote-only board - only exclude on job type when the
    // candidate explicitly ruled out every remote-compatible type.
    const explicitNonRemoteOnly =
      (criteria.jobTypes || []).length > 0 &&
      criteria.jobTypes!.every((t) => !['REMOTE', 'ONLINE', 'FREELANCE', 'CONTRACT', 'FULL_TIME', 'PART_TIME', 'CUSTOM'].includes(t.toUpperCase()));
    if (explicitNonRemoteOnly) return [];

    const oldestAllowed = Date.now() - MAX_LISTING_AGE_DAYS * 24 * 60 * 60_000;

    return jobs
      .filter((j) => {
        const postedMs = j.pubDate ? Date.parse(j.pubDate) : NaN;
        if (Number.isNaN(postedMs) || postedMs < oldestAllowed) return false;

        if (query) {
          const industry = flatten(j.jobIndustry).join(' ');
          const haystack = `${j.jobTitle} ${j.companyName || ''} ${industry}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        if (location && j.jobGeo && !j.jobGeo.toLowerCase().includes(location)) {
          // "Worldwide"/unspecified geo is not a restriction, only an explicit mismatch is.
          if (!j.jobGeo.toLowerCase().includes('worldwide')) return false;
        }
        return true;
      })
      .sort((a, b) => Date.parse(b.pubDate || '') - Date.parse(a.pubDate || ''));
  }

  private toRawListing(j: JobicyJob): RawJobListing {
    const mappedType = flatten(j.jobType)
      .map((t) => JOB_TYPE_MAP[t.toLowerCase().trim()])
      .find(Boolean);
    const salary =
      j.salaryMin || j.salaryMax
        ? formatSalary(j.salaryMin, j.salaryMax, j.salaryCurrency, j.salaryPeriod)
        : undefined;

    return {
      source: 'jobicy',
      externalId: String(j.id),
      title: j.jobTitle,
      company: j.companyName,
      location: j.jobGeo || 'Remote',
      jobType: mappedType || 'REMOTE',
      description: truncate(stripHtml(j.jobDescription || j.jobExcerpt || ''), 900),
      applyUrl: j.url,
      salary,
      postedAt: j.pubDate ? new Date(j.pubDate) : undefined,
      raw: { jobicyId: j.id, jobicyUrl: j.url, industry: j.jobIndustry, level: j.jobLevel },
    };
  }
}

function flatten(value?: string | string[]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : value.split(',').map((v) => v.trim());
}

function formatSalary(min?: number, max?: number, currency?: string, period?: string): string {
  const cur = currency || 'USD';
  const per = period ? `/${period}` : '';
  if (min && max) return `${cur} ${min.toLocaleString()} - ${max.toLocaleString()}${per}`;
  return `${cur} ${(min || max || 0).toLocaleString()}${per}`;
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
