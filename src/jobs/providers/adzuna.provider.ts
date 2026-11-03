import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JobSourceProvider, JobSourceCriteria, RawJobListing, MAX_LISTING_AGE_DAYS } from './job-source.interface';
import { ResumeProfile } from '../../ai/gemini.service';
import { fetchJsonWithRetry } from './fetch-with-diagnostics';

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX_ENTRIES = 100;
const RESULTS_PER_COUNTRY = 30;

interface AdzunaResult {
  id?: string;
  title: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
  description?: string;
  redirect_url: string; // Adzuna's own redirect, which forwards to the real posting on its original site
  created?: string; // ISO date
  salary_min?: number;
  salary_max?: number;
  salary_is_predicted?: string | number;
  contract_type?: string; // "permanent" | "contract"
  contract_time?: string; // "full_time" | "part_time"
}

/**
 * Pulls real job listings from Adzuna's search API (developer.adzuna.com) -
 * an aggregator that indexes postings from thousands of employer career
 * pages and other job boards across ~20 country markets. This is the
 * closest thing in this codebase to "every job site": far broader reach
 * than Remotive/RemoteOK/Arbeitnow/Jobicy combined, at the cost of needing
 * a free API key (register at https://developer.adzuna.com - instant, no
 * cost).
 *
 * Whether this source is switched ON is decided ELSEWHERE, by
 * JobSourceSettingsService (a single document in Mongo, exposed at
 * GET/PUT /job-sources/settings) - not by this file. This provider only
 * cares whether it has credentials to actually call Adzuna with; without
 * them it quietly contributes zero results rather than breaking job search.
 *
 * Env vars:
 *   ADZUNA_APP_ID / ADZUNA_APP_KEY - required for this source to return
 *     anything. Get a free pair at https://developer.adzuna.com.
 *   ADZUNA_ENABLED - only read ONCE, the very first time the app starts
 *     against a fresh database, to seed the initial value of the persisted
 *     on/off setting above. After that first run, this env var is never
 *     looked at again - flip the setting via PUT /job-sources/settings (or
 *     the "Search source" picker in the UI, if it offers an enable action)
 *     instead of editing .env, since an .env edit after the first run has
 *     no effect.
 *   ADZUNA_COUNTRIES - comma-separated Adzuna country codes to search
 *     (e.g. "us,gb,ca,au,de"). Defaults to "us,gb". Adzuna is indexed
 *     per-country, so this trades free-tier call quota for breadth - the
 *     default keeps quota usage modest; widen it if your Adzuna plan allows.
 */
@Injectable()
export class AdzunaJobSourceProvider implements JobSourceProvider {
  name = 'adzuna';
  private readonly logger = new Logger(AdzunaJobSourceProvider.name);
  private readonly appId?: string;
  private readonly appKey?: string;
  private readonly countries: string[];
  private warnedMissingCredentials = false;
  private cache = new Map<string, { fetchedAt: number; jobs: RawJobListing[] }>();

  constructor(config: ConfigService) {
    this.appId = config.get<string>('ADZUNA_APP_ID') || undefined;
    this.appKey = config.get<string>('ADZUNA_APP_KEY') || undefined;
    this.countries = (config.get<string>('ADZUNA_COUNTRIES') || 'us,gb')
      .split(',')
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean);
  }

  async search(_profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    // Whether this source runs at all is decided upstream, by
    // JobsService.collectRealListings via JobSourceSettingsService (backed by
    // the /job-sources/settings endpoint, not by this provider) - see that
    // service for why. This provider only needs to check that it has
    // credentials to actually call Adzuna with.
    if (!this.appId || !this.appKey) {
      if (!this.warnedMissingCredentials) {
        this.logger.warn(
          'Adzuna is enabled in job-source settings but ADZUNA_APP_ID/ADZUNA_APP_KEY are not set - skipping ' +
            'the Adzuna source until both are configured (get a free key from developer.adzuna.com).',
        );
        this.warnedMissingCredentials = true;
      }
      return [];
    }

    const cacheKey = JSON.stringify({
      q: criteria.query || '',
      loc: criteria.location || '',
      countries: this.countries,
    });
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.jobs;

    const perCountry = await Promise.all(this.countries.map((country) => this.searchCountry(country, criteria)));
    const jobs = perCountry.flat();

    this.cache.set(cacheKey, { fetchedAt: Date.now(), jobs });
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    return jobs;
  }

  private async searchCountry(country: string, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    const params = new URLSearchParams({
      app_id: this.appId!,
      app_key: this.appKey!,
      results_per_page: String(RESULTS_PER_COUNTRY),
      'content-type': 'application/json',
      sort_by: 'date',
      max_days_old: String(MAX_LISTING_AGE_DAYS), // Adzuna filters server-side - only actively-recent postings come back at all
    });
    if (criteria.query) params.set('what', criteria.query);
    if (criteria.location) params.set('where', criteria.location);

    let body: { results?: AdzunaResult[] };
    try {
      body = await fetchJsonWithRetry<{ results?: AdzunaResult[] }>(
        `https://api.adzuna.com/v1/api/jobs/${country}/search/1?${params.toString()}`,
        { label: `Adzuna (${country})` },
      );
    } catch (err) {
      this.logger.warn(`Adzuna fetch failed for country "${country}", skipping it: ${(err as Error).message}`);
      return [];
    }
    const results = Array.isArray(body?.results) ? body.results : [];
    return results.map((r) => this.toRawListing(r, country));
  }

  private toRawListing(r: AdzunaResult, country: string): RawJobListing {
    const predicted = r.salary_is_predicted === '1' || r.salary_is_predicted === 1;
    const salary =
      r.salary_min || r.salary_max
        ? `${formatSalary(r.salary_min, r.salary_max)}${predicted ? ' (estimated)' : ''}`
        : undefined;

    return {
      source: 'adzuna',
      externalId: r.id,
      title: r.title,
      company: r.company?.display_name,
      location: r.location?.display_name,
      jobType: mapJobType(r.contract_time, r.contract_type),
      description: truncate((r.description || '').trim(), 900),
      applyUrl: r.redirect_url,
      salary,
      postedAt: r.created ? new Date(r.created) : undefined,
      raw: { adzunaId: r.id, adzunaCountry: country },
    };
  }
}

function mapJobType(contractTime?: string, contractType?: string): string {
  if (contractTime === 'full_time') return 'FULL_TIME';
  if (contractTime === 'part_time') return 'PART_TIME';
  if (contractType === 'contract') return 'CONTRACT';
  if (contractType === 'permanent') return 'FULL_TIME';
  return 'CUSTOM';
}

function formatSalary(min?: number, max?: number): string {
  if (min && max) return `$${Math.round(min).toLocaleString()} - $${Math.round(max).toLocaleString()}`;
  return `$${Math.round(min || max || 0).toLocaleString()}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}
