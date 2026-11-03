import { Injectable, Logger } from '@nestjs/common';
import { JobSourceProvider, JobSourceCriteria, RawJobListing, MAX_LISTING_AGE_DAYS } from './job-source.interface';
import { ResumeProfile } from '../../ai/gemini.service';
import { fetchJsonWithRetry } from './fetch-with-diagnostics';

const ARBEITNOW_URL = 'https://www.arbeitnow.com/api/job-board-api';
const CACHE_TTL_MS = 20 * 60_000;
// Arbeitnow paginates rather than taking a single "give me N" param. A
// couple of pages is enough breadth per cache window without hammering it -
// its own API terms ask callers not to abuse the service.
const PAGES_TO_FETCH = 2;

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title: string;
  description?: string; // HTML
  remote?: boolean;
  url: string;
  tags?: string[];
  job_types?: string[]; // e.g. ["Full-time"]
  location?: string;
  created_at?: number; // unix epoch seconds
}

const JOB_TYPE_MAP: Record<string, string> = {
  'full-time': 'FULL_TIME',
  'part-time': 'PART_TIME',
  contract: 'CONTRACT',
  freelance: 'FREELANCE',
  internship: 'INTERNSHIP',
};

/**
 * Pulls real, currently-open postings from Arbeitnow's free public JSON API
 * (https://www.arbeitnow.com/api/job-board-api) - no API key, no LLM call.
 * Heavily weighted toward Germany/EU plus English-language remote roles, so
 * it's a useful complement to Remotive/RemoteOK's more US-centric coverage.
 *
 * Attribution note: Arbeitnow's terms ask published uses to link back to
 * the listing's own `url` - kept in `raw.arbeitnowUrl` on every listing.
 */
@Injectable()
export class ArbeitnowJobSourceProvider implements JobSourceProvider {
  name = 'arbeitnow';
  private readonly logger = new Logger(ArbeitnowJobSourceProvider.name);
  private cache: { fetchedAt: number; jobs: ArbeitnowJob[] } | null = null;
  private inFlight: Promise<ArbeitnowJob[]> | null = null;

  async search(_profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    const jobs = await this.getFeed();
    return this.filter(jobs, criteria).map((j) => this.toRawListing(j));
  }

  private async getFeed(): Promise<ArbeitnowJob[]> {
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
          this.logger.warn(`Arbeitnow fetch failed (${reason}); serving previously cached listings instead.`);
          return this.cache.jobs;
        }
        this.logger.warn(`Arbeitnow fetch failed (${reason}); no cached listings available.`);
        return [];
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchFeed(): Promise<ArbeitnowJob[]> {
    const all: ArbeitnowJob[] = [];
    for (let page = 1; page <= PAGES_TO_FETCH; page++) {
      let body: { data?: ArbeitnowJob[] };
      try {
        body = await fetchJsonWithRetry<{ data?: ArbeitnowJob[] }>(`${ARBEITNOW_URL}?page=${page}`, {
          label: 'Arbeitnow',
        });
      } catch (err) {
        // Don't let a bad later page throw away pages we already got.
        if (all.length) break;
        throw err;
      }
      const pageJobs = Array.isArray(body?.data) ? body.data : [];
      if (!pageJobs.length) break; // ran out of pages
      all.push(...pageJobs);
    }
    return all;
  }

  private filter(jobs: ArbeitnowJob[], criteria: JobSourceCriteria): ArbeitnowJob[] {
    const query = criteria.query?.toLowerCase().trim();
    const location = criteria.location?.toLowerCase().trim();
    const wantedTypes = new Set(
      (criteria.jobTypes || [])
        .map((t) => t.toUpperCase())
        .filter((t) => Object.values(JOB_TYPE_MAP).includes(t) || t === 'REMOTE'),
    );
    const oldestAllowed = Date.now() - MAX_LISTING_AGE_DAYS * 24 * 60 * 60_000;

    return jobs
      .filter((j) => {
        const postedMs = j.created_at ? j.created_at * 1000 : null;
        if (postedMs == null || postedMs < oldestAllowed) return false;

        if (query) {
          const haystack = `${j.title} ${j.company_name || ''} ${(j.tags || []).join(' ')}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        if (location && !(j.location || '').toLowerCase().includes(location) && !j.remote) return false;
        if (wantedTypes.size && !(wantedTypes.has('REMOTE') && j.remote)) {
          const mapped = (j.job_types || []).map((t) => JOB_TYPE_MAP[t.toLowerCase()]).filter(Boolean);
          if (!mapped.some((t) => wantedTypes.has(t!))) return false;
        }
        return true;
      })
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  private toRawListing(j: ArbeitnowJob): RawJobListing {
    const mappedType = (j.job_types || []).map((t) => JOB_TYPE_MAP[t.toLowerCase()]).find(Boolean);
    return {
      source: 'arbeitnow',
      externalId: j.slug,
      title: j.title,
      company: j.company_name,
      location: j.location || (j.remote ? 'Remote' : undefined),
      jobType: mappedType || (j.remote ? 'REMOTE' : 'CUSTOM'),
      description: truncate(stripHtml(j.description || ''), 900),
      applyUrl: j.url,
      postedAt: j.created_at ? new Date(j.created_at * 1000) : undefined,
      raw: { arbeitnowSlug: j.slug, arbeitnowUrl: j.url, tags: j.tags },
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
