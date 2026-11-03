import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResumeProfile } from '../ai/gemini.service';
import { BaseJobScraper } from '../jobs/providers/base-job-scraper';
import { JobSourceCriteria, RawJobListing } from '../jobs/providers/job-source.interface';
import { fetchJsonWithRetry } from '../jobs/providers/fetch-with-diagnostics';

/**
 * Last-resort source: runs an Apify Actor (a hosted job scraper) and reads its
 * dataset. Apify bills per run, so AiTrainingJobsService only calls this after
 * the free sources came back short, and caches each distinct query for 30 min.
 *
 * It is OFF until you set:
 *   APIFY_TOKEN        your Apify API token
 *   APIFY_ACTOR_ID     "username~actor-name" of a job-scraper actor you chose
 * Optional:
 *   APIFY_ACTOR_INPUT  JSON input for that actor. The strings "{{query}}" and
 *                      "{{limit}}" are replaced (limit becomes a number), e.g.
 *                      {"searchQueries":["{{query}}"],"maxItems":"{{limit}}"}
 *                      Default: {"query":"{{query}}","maxItems":"{{limit}}"}
 *   APIFY_MAX_ITEMS    cap per run (default 50)
 *   APIFY_TIMEOUT_SECS wait limit per run (default 90)
 *
 * Every actor names its input and output fields differently, so check yours in
 * the Apify console. Input is fully configurable above; output field names are
 * matched against the common variants below (title/positionName/jobTitle, ...).
 */
@Injectable()
export class ApifyJobSourceProvider extends BaseJobScraper<Record<string, any>> implements OnModuleInit {
  readonly name = 'apify';
  protected readonly logger = new Logger(ApifyJobSourceProvider.name);
  private readonly token: string;
  private readonly actorId: string;
  private readonly inputTemplate: any;
  private readonly maxItems: number;
  private readonly timeoutSecs: number;

  constructor(config: ConfigService) {
    super();
    this.token = config.get<string>('APIFY_TOKEN') || '';
    this.actorId = (config.get<string>('APIFY_ACTOR_ID') || '').replace('/', '~');
    this.trustResults = (config.get<string>('APIFY_TRUST_RESULTS') || 'true').toLowerCase() !== 'false';
    this.maxItems = Number(config.get<string>('APIFY_MAX_ITEMS')) || 50;
    this.timeoutSecs = Number(config.get<string>('APIFY_TIMEOUT_SECS')) || 90;
    try {
      this.inputTemplate = JSON.parse(config.get<string>('APIFY_ACTOR_INPUT') || '{"query":"{{query}}","maxItems":"{{limit}}"}');
    } catch {
      this.logger.warn('APIFY_ACTOR_INPUT is not valid JSON - using the default input shape.');
      this.inputTemplate = { query: '{{query}}', maxItems: '{{limit}}' };
    }
  }

  /**
   * When true (default) every listing the actor returns is treated as AI-training work, because you
   * picked an AI-training actor. Set APIFY_TRUST_RESULTS=false for a general job scraper so the
   * keyword classifier filters its output instead.
   */
  readonly trustResults: boolean;
  private lastRawCount = 0;
  private lastSampleKeys: string[] = [];

  onModuleInit() {
    if (this.isEnabled()) {
      this.logger.log(`Apify enabled: actor "${this.actorId}" (max ${this.maxItems} items, ${this.timeoutSecs}s timeout, results ${this.trustResults ? 'trusted' : 'filtered by keywords'}).`);
    } else {
      this.logger.warn(
        'Apify is DISABLED: set both APIFY_TOKEN and APIFY_ACTOR_ID in .env (then restart) to turn the Apify fallback on. ' +
          `Currently: APIFY_TOKEN ${this.token ? 'set' : 'MISSING'}, APIFY_ACTOR_ID ${this.actorId ? 'set' : 'MISSING'}.`,
      );
    }
  }

  async search(profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    const out = await super.search(profile, criteria);
    if (this.lastRawCount > 0 && out.length === 0) {
      this.logger.warn(
        `Apify returned ${this.lastRawCount} item(s) but none were usable. Each needs a title and a link, and must be ` +
          `under 30 days old. Fields on the first item: [${this.lastSampleKeys.join(', ')}]. ` +
          'If your actor uses other field names, tell me these and I will map them.',
      );
    }
    return out;
  }

  isEnabled(): boolean {
    return !!(this.token && this.actorId);
  }

  protected async fetchRawData(criteria: JobSourceCriteria, _profile: ResumeProfile): Promise<Record<string, any>[]> {
    if (!this.isEnabled()) return [];
    const limit = Math.min(criteria.limit ?? this.maxItems, this.maxItems);
    const query = criteria.query ? `AI training ${criteria.query}` : 'AI trainer';
    const input = fill(this.inputTemplate, query, limit);

    const items = await fetchJsonWithRetry<any>(
      `https://api.apify.com/v2/acts/${encodeURIComponent(this.actorId)}/run-sync-get-dataset-items?timeout=${this.timeoutSecs}&limit=${limit}`,
      {
        label: 'Apify',
        timeoutMs: (this.timeoutSecs + 15) * 1000,
        retries: 0, // a retry would start (and bill) a second run
        init: {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
          body: JSON.stringify(input),
        },
      },
    );
    const list = Array.isArray(items) ? items : [];
    this.lastRawCount = list.length;
    this.lastSampleKeys = list[0] && typeof list[0] === 'object' ? Object.keys(list[0]).slice(0, 25) : [];
    this.logger.log(`Apify run for "${query}" returned ${list.length} item(s).`);
    return list;
  }

  protected normalizeData(item: Record<string, any>): RawJobListing | null {
    const title = str(item.title ?? item.positionName ?? item.jobTitle ?? item.name ?? item.position);
    const applyUrl = str(item.applyUrl ?? item.applyLink ?? item.url ?? item.link ?? item.jobUrl ?? item.externalApplyLink);
    if (!title || !applyUrl) return null;

    const company = item.company ?? item.companyName ?? item.organization ?? item.employer;
    const posted = item.postedAt ?? item.datePosted ?? item.publishedAt ?? item.postedDate ?? item.date ?? item.posted;
    const postedAt = posted ? new Date(posted) : undefined;
    const location = str(item.location ?? item.jobLocation ?? item.city);

    return {
      source: 'apify',
      externalId: str(item.id ?? item.jobId ?? item.guid) || applyUrl,
      title,
      company: typeof company === 'object' && company ? str(company.name) : str(company),
      location,
      jobType: 'CONTRACT',
      description: strip(str(item.description ?? item.descriptionText ?? item.snippet ?? item.summary) || '').slice(0, 900),
      applyUrl,
      salary: str(item.salary ?? item.salaryText ?? item.pay),
      isRemote: item.isRemote === true || /remote/i.test(location || ''),
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : undefined,
    };
  }
}

function fill(node: any, query: string, limit: number): any {
  if (typeof node === 'string') {
    if (node === '{{query}}') return query;
    if (node === '{{limit}}') return limit;
    return node.replace('{{query}}', query);
  }
  if (Array.isArray(node)) return node.map((n) => fill(n, query, limit));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, query, limit)]));
  }
  return node;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
}

function strip(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
