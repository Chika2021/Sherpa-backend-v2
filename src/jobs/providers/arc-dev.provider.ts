import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResumeProfile } from '../../ai/gemini.service';
import { BaseJobScraper } from './base-job-scraper';
import { JobSourceCriteria, RawJobListing } from './job-source.interface';
import { fetchTextWithRetry } from './fetch-with-diagnostics';
import { extractAttr, extractFeedItems, extractTag, stripHtmlTags } from './html-parse-utils';

const CACHE_TTL_MS = 20 * 60_000;
const DEFAULT_FEED_URL = 'https://arc.dev/remote-jobs.rss';
const DEFAULT_LISTING_PAGE = 'https://arc.dev/remote-jobs';

interface ArcDevItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
  guid?: string;
}

/**
 * Pulls listings from arc.dev (Arc, formerly CodementorX/CodeSubmit's
 * remote-jobs board). Prefers their public RSS feed - structured, stable,
 * and far cheaper to poll than rendering the page - and only falls back to
 * parsing the HTML listing page if the feed is unreachable or arc.dev
 * changes/removes it.
 *
 * Both paths use plain regex parsing (see html-parse-utils.ts) rather than a
 * real XML/HTML parser, since this project has neither installed. The RSS
 * path is reasonably durable (RSS's tag set rarely changes); the HTML
 * fallback is NOT - arc.dev can change its markup at any time and silently
 * break the CSS-selector-shaped regexes below. Treat the fallback as a
 * best-effort "something is usually better than nothing", not a guaranteed
 * source, and watch its logs for "0 raw HTML matches" warnings, which mean
 * it's time to update the selectors (or add a real parser - see
 * html-parse-utils.ts's own note on that).
 *
 * Env vars:
 *   ARC_DEV_ENABLED      set to "true" to turn this source on. Off by
 *     default, same as the other opt-in sources in this folder - a scraped
 *     source that isn't actively watched for markup drift is safer as an
 *     explicit choice than something silently running out of the box.
 *   ARC_DEV_FEED_URL     override the RSS feed URL (optional).
 *   ARC_DEV_LISTING_URL  override the HTML listing page used as fallback
 *     (optional).
 */
@Injectable()
export class ArcDevJobSourceProvider extends BaseJobScraper<ArcDevItem> {
  readonly name = 'arc-dev';
  protected readonly logger = new Logger(ArcDevJobSourceProvider.name);
  private readonly enabled: boolean;
  private readonly feedUrl: string;
  private readonly listingUrl: string;
  private cache: { fetchedAt: number; items: ArcDevItem[] } | null = null;
  private warnedDisabled = false;

  constructor(config: ConfigService) {
    super();
    this.enabled = config.get<string>('ARC_DEV_ENABLED') === 'true';
    this.feedUrl = config.get<string>('ARC_DEV_FEED_URL') || DEFAULT_FEED_URL;
    this.listingUrl = config.get<string>('ARC_DEV_LISTING_URL') || DEFAULT_LISTING_PAGE;
  }

  protected async fetchRawData(_criteria: JobSourceCriteria, _profile: ResumeProfile): Promise<ArcDevItem[]> {
    if (!this.enabled) {
      // Off by default - log it once so it's easy to notice this source
      // exists but is switched off, without spamming the log on every search.
      if (!this.warnedDisabled) {
        this.logger.log('ARC_DEV_ENABLED is not "true" - skipping the arc.dev source. Other job sources still run normally.');
        this.warnedDisabled = true;
      }
      return [];
    }

    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache.items;

    let items: ArcDevItem[];
    try {
      items = await this.fetchViaFeed();
      if (items.length === 0) throw new Error('feed returned zero items');
    } catch (feedErr) {
      this.logger.warn(`arc.dev RSS feed unavailable (${(feedErr as Error).message}) - falling back to HTML parsing.`);
      try {
        items = await this.fetchViaHtml();
      } catch (htmlErr) {
        this.logger.warn(`arc.dev HTML fallback also failed: ${(htmlErr as Error).message}`);
        items = [];
      }
    }

    this.cache = { fetchedAt: Date.now(), items };
    return items;
  }

  private async fetchViaFeed(): Promise<ArcDevItem[]> {
    const xml = await fetchTextWithRetry(this.feedUrl, {
      label: 'arc.dev RSS feed',
      init: { headers: { Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' } },
    });
    const blocks = extractFeedItems(xml);
    return blocks
      .map((block): ArcDevItem | null => {
        const title = extractTag(block, 'title');
        // RSS uses <link>text</link>; Atom uses <link href="...">.
        const link = extractTag(block, 'link') || extractAttr(block, 'link', 'href');
        if (!title || !link) return null;
        return {
          title,
          link,
          description: extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content') || '',
          pubDate: extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated'),
          guid: extractTag(block, 'guid'),
        };
      })
      .filter((i): i is ArcDevItem => !!i);
  }

  /**
   * Best-effort HTML fallback. arc.dev's listing page renders job cards as
   * anchors linking to `/remote-jobs/<slug>`; this looks for that link
   * pattern and pulls the nearest heading text as the title, which is
   * fragile by nature (see class-level doc comment) but requires no new
   * dependency and degrades to "zero results, logged clearly" rather than
   * throwing if the site's markup no longer matches.
   */
  private async fetchViaHtml(): Promise<ArcDevItem[]> {
    const html = await fetchTextWithRetry(this.listingUrl, {
      label: 'arc.dev listing page',
      init: { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; job-apply-backend/1.0; +https://arc.dev)' } },
    });

    const cardPattern = /<a[^>]+href=["'](\/remote-jobs\/[a-z0-9-]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const items: ArcDevItem[] = [];
    let match: RegExpExecArray | null;
    while ((match = cardPattern.exec(html))) {
      const [, path, innerHtml] = match;
      const title = stripHtmlTags(innerHtml);
      if (!title) continue;
      items.push({ title, link: new URL(path, this.listingUrl).toString(), description: '' });
    }
    if (items.length === 0) {
      this.logger.warn('arc.dev HTML fallback: 0 matches for the expected job-card pattern - arc.dev likely changed its markup; update the selector in arc-dev.provider.ts.');
    }
    return items;
  }

  protected normalizeData(item: ArcDevItem, _criteria: JobSourceCriteria): RawJobListing | null {
    if (!item.title || !item.link) return null;
    const description = stripHtmlTags(item.description || '');
    // arc.dev titles are commonly formatted "Senior React Developer at Acme
    // Corp" - split that out when present so `company` isn't always empty
    // for the HTML-fallback path (which has no separate company field).
    const atMatch = item.title.match(/^(.*)\bat\b\s+(.+)$/i);
    const title = atMatch ? atMatch[1].trim() : item.title;
    const company = atMatch ? atMatch[2].trim() : undefined;

    return {
      source: 'arc-dev',
      externalId: item.guid || item.link,
      title,
      company,
      location: 'Remote',
      isRemote: true,
      jobType: 'REMOTE',
      description,
      applyUrl: item.link,
      postedAt: item.pubDate ? parseDate(item.pubDate) : undefined,
      raw: { arcDevGuid: item.guid },
    };
  }
}

function parseDate(value: string): Date | undefined {
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t);
}
