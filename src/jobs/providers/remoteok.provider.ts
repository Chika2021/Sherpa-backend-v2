import { Injectable, Logger } from '@nestjs/common';
import { JobSourceProvider, JobSourceCriteria, RawJobListing, MAX_LISTING_AGE_DAYS } from './job-source.interface';
import { ResumeProfile } from '../../ai/gemini.service';
import { fetchJsonWithRetry } from './fetch-with-diagnostics';

const REMOTEOK_URL = 'https://remoteok.com/api';
// Independent of RemotiveJobSourceProvider's cache/host, so if one of the two
// APIs is unreachable or blocked from this server's network/IP, the other
// still gets us real listings without ever touching the AI at all.
const CACHE_TTL_MS = 20 * 60_000;

interface RemoteOkJob {
  id?: string | number;
  slug?: string;
  legal?: string; // present only on the feed's first element, which is a notice, not a job - skip it
  position?: string;
  title?: string; // some historical records use `title` instead of `position`
  company?: string;
  tags?: string[];
  location?: string;
  description?: string; // HTML
  salary_min?: number;
  salary_max?: number;
  date?: string;
  epoch?: number;
  url?: string; // remoteok.com listing page
  apply_url?: string; // direct application link, when RemoteOK has one
}

/**
 * Pulls real, currently-open remote postings from RemoteOK's free public
 * JSON API (https://remoteok.com/api) - no API key, no LLM call. Exists
 * alongside RemotiveJobSourceProvider purely for redundancy: job search
 * should never depend on any single third-party API being reachable.
 *
 * Attribution note: RemoteOK's terms ask published uses to link back to the
 * listing's own `url` and credit RemoteOK as the source - kept in
 * `raw.remoteOkUrl` on every listing below.
 */
@Injectable()
export class RemoteOkJobSourceProvider implements JobSourceProvider {
  name = 'remoteok';
  private readonly logger = new Logger(RemoteOkJobSourceProvider.name);
  private cache: { fetchedAt: number; jobs: RemoteOkJob[] } | null = null;
  private inFlight: Promise<RemoteOkJob[]> | null = null;

  async search(_profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    const jobs = await this.getFeed();
    return this.filter(jobs, criteria).map((j) => this.toRawListing(j));
  }

  private async getFeed(): Promise<RemoteOkJob[]> {
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
          this.logger.warn(`RemoteOK fetch failed (${reason}); serving previously cached listings instead.`);
          return this.cache.jobs;
        }
        this.logger.warn(`RemoteOK fetch failed (${reason}); no cached listings available.`);
        return [];
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchFeed(): Promise<RemoteOkJob[]> {
    // RemoteOK blocks requests with no/default User-Agent (returns an
    // empty or error response), unlike Remotive which doesn't care.
    const body = await fetchJsonWithRetry<RemoteOkJob[]>(REMOTEOK_URL, {
      label: 'RemoteOK',
      init: {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; job-apply-backend/1.0; +https://remoteok.com/api terms honored)',
          Accept: 'application/json',
        },
      },
    });
    if (!Array.isArray(body)) throw new Error('RemoteOK response was not an array');
    // First element is a legal/meta notice, not a job - drop anything that
    // looks like it (has `legal` and no `position`/`title`) rather than
    // assuming it's always exactly index 0.
    return body.filter((j: RemoteOkJob) => !j.legal && (j.position || j.title));
  }

  private filter(jobs: RemoteOkJob[], criteria: JobSourceCriteria): RemoteOkJob[] {
    const query = criteria.query?.toLowerCase().trim();
    const location = criteria.location?.toLowerCase().trim();
    const oldestAllowed = Date.now() - MAX_LISTING_AGE_DAYS * 24 * 60 * 60_000;
    // RemoteOK doesn't publish full/part-time vs contract as a field the way
    // Remotive does - almost everything on it is just "remote". Only filter
    // by type when the candidate explicitly ruled out REMOTE/ONLINE-style types.
    const explicitNonRemoteOnly =
      (criteria.jobTypes || []).length > 0 &&
      criteria.jobTypes!.every((t) => !['REMOTE', 'ONLINE', 'FREELANCE', 'CONTRACT', 'FULL_TIME', 'CUSTOM'].includes(t.toUpperCase()));
    if (explicitNonRemoteOnly) return [];

    return jobs
      .filter((j) => {
        if (!j.apply_url && !j.url) return false; // no usable link - schema requires applyUrl

        // "Actively recruiting" proxy: RemoteOK has no open/closed flag, so
        // treat anything older than MAX_LISTING_AGE_DAYS as likely stale/filled.
        const postedMs = postedAtMs(j);
        if (postedMs == null || postedMs < oldestAllowed) return false;

        const title = j.position || j.title || '';
        if (query) {
          const haystack = `${title} ${j.company || ''} ${(j.tags || []).join(' ')}`.toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        if (location && j.location && !j.location.toLowerCase().includes(location)) {
          // RemoteOK listings are inherently remote; an empty/"Worldwide"-ish
          // location field is not a restriction, so only reject an explicit mismatch.
          return false;
        }
        return true;
      })
      .sort((a, b) => (postedAtMs(b) ?? 0) - (postedAtMs(a) ?? 0));
  }

  private toRawListing(j: RemoteOkJob): RawJobListing {
    const title = j.position || j.title || 'Remote role';
    const salary = j.salary_min || j.salary_max ? formatSalary(j.salary_min, j.salary_max) : undefined;
    const postedMs = postedAtMs(j);

    return {
      source: 'remoteok',
      externalId: j.id != null ? String(j.id) : j.slug,
      title,
      company: j.company,
      location: j.location || 'Remote',
      jobType: 'REMOTE',
      description: truncate(stripHtml(j.description || ''), 900),
      applyUrl: j.apply_url || j.url || '',
      salary,
      postedAt: postedMs != null ? new Date(postedMs) : undefined,
      raw: { remoteOkId: j.id, remoteOkUrl: j.url, tags: j.tags },
    };
  }
}

function postedAtMs(j: RemoteOkJob): number | null {
  if (j.date) {
    const parsed = Date.parse(j.date);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (j.epoch) return j.epoch * 1000;
  return null;
}

function formatSalary(min?: number, max?: number): string {
  if (min && max) return `$${min.toLocaleString()} - $${max.toLocaleString()}`;
  return `$${(min || max || 0).toLocaleString()}`;
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
