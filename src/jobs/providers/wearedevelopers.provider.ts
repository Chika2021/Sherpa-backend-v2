import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResumeProfile } from '../../ai/gemini.service';
import { BaseJobScraper } from './base-job-scraper';
import { JobSourceCriteria, RawJobListing } from './job-source.interface';
import { absoluteUrl, fetchCheerio, jsonLdJobPostings, textOf } from './html-scraper.util';

const DEFAULT_LISTING_URL = 'https://www.wearedevelopers.com/jobs';
const CACHE_TTL_MS = 30 * 60_000; // scraped pages change slowly - cache generously

interface WeAreDevelopersListing {
  title: string;
  company?: string;
  location?: string;
  link: string;
  isRemote?: boolean;
}

/**
 * Scrapes WeAreDevelopers' job board (wearedevelopers.com/jobs) with plain `fetch` + Cheerio.
 *
 * IMPORTANT: Cheerio does not run JavaScript. It only sees the HTML the server returns. This site is a
 * JS-rendered app, so listings only show up here if they are present in that initial HTML - either as
 * server-rendered cards or as schema.org JobPosting JSON-LD, both of which are tried below. If neither is
 * present the provider logs a clear "0 listings" warning and returns nothing (other sources still run).
 *
 * CSS-selector fragility: the selectors in `scrape()` are a best guess at the site's markup and live in ONE
 * place so they are easy to update.
 *
 * Env vars:
 *   WEAREDEVELOPERS_ENABLED - set to "true" to turn this source on (off by default).
 *   WEAREDEVELOPERS_LISTING_URL - optional, override the page URL.
 */
@Injectable()
export class WeAreDevelopersJobSourceProvider extends BaseJobScraper<WeAreDevelopersListing> {
  readonly name = 'wearedevelopers';
  protected readonly logger = new Logger(WeAreDevelopersJobSourceProvider.name);
  private readonly enabled: boolean;
  private readonly listingUrl: string;
  private cache: { fetchedAt: number; listings: WeAreDevelopersListing[] } | null = null;
  private inFlight: Promise<WeAreDevelopersListing[]> | null = null;
  private warnedDisabled = false;

  constructor(config: ConfigService) {
    super();
    this.enabled = config.get<string>('WEAREDEVELOPERS_ENABLED') === 'true';
    this.listingUrl = config.get<string>('WEAREDEVELOPERS_LISTING_URL') || DEFAULT_LISTING_URL;
  }

  protected async fetchRawData(
    _criteria: JobSourceCriteria,
    _profile: ResumeProfile,
  ): Promise<WeAreDevelopersListing[]> {
    if (!this.enabled) {
      // Off by default - log it once so it's easy to notice this source
      // exists but is switched off, without spamming the log on every search.
      if (!this.warnedDisabled) {
        this.logger.log('WEAREDEVELOPERS_ENABLED is not "true" - skipping the WeAreDevelopers source. Other job sources still run normally.');
        this.warnedDisabled = true;
      }
      return [];
    }
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache.listings;
    // De-dupe concurrent cache misses into one fetch rather than one per simultaneous search.
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.scrape()
      .then((listings) => {
        this.cache = { fetchedAt: Date.now(), listings };
        return listings;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async scrape(): Promise<WeAreDevelopersListing[]> {
    try {
      const $ = await fetchCheerio(this.listingUrl, this.logger, 'WeAreDevelopers');

      // 1) schema.org JobPosting JSON-LD (most reliable when a site provides it)
      const fromJsonLd = jsonLdJobPostings($)
        .map((j): WeAreDevelopersListing | null => {
          const location = j.jobLocation?.address?.addressLocality || j.jobLocation?.address?.addressCountry;
          const link = absoluteUrl(j.url, this.listingUrl);
          if (!j.title || !link) return null;
          return {
            title: String(j.title).trim(),
            company: j.hiringOrganization?.name || undefined,
            location: typeof location === 'string' ? location : undefined,
            link,
            isRemote: j.jobLocationType === 'TELECOMMUTE' || /remote/i.test(String(location || '')),
          };
        })
        .filter((l): l is WeAreDevelopersListing => !!l);

      // 2) server-rendered job cards
      const fromCards: WeAreDevelopersListing[] = [];
      $('[data-testid="job-card"], .job-card, article').each((_i, el) => {
        const card = $(el);
        const link = absoluteUrl(card.find('a[href*="/jobs/"]').first().attr('href'), this.listingUrl);
        const title = textOf(card.find('h2, h3, [data-testid="job-title"]').first());
        if (!link || !title) return;
        const location = textOf(card.find('[data-testid="job-location"], .job-location').first());
        fromCards.push({
          title,
          company: textOf(card.find('[data-testid="company-name"], .company-name').first()) || undefined,
          location: location || undefined,
          link,
          isRemote: /remote/i.test(location),
        });
      });

      // De-dupe by link, JSON-LD first
      const byLink = new Map<string, WeAreDevelopersListing>();
      for (const l of [...fromJsonLd, ...fromCards]) if (!byLink.has(l.link)) byLink.set(l.link, l);
      const listings = [...byLink.values()];

      if (listings.length === 0) {
        this.logger.warn(
          'WeAreDevelopers: 0 listings found in the raw HTML - the page is probably rendered client-side (Cheerio does not run JavaScript), has no openings, or changed its markup. Update the selectors in wearedevelopers.provider.ts or switch to the site\'s JSON endpoint.',
        );
      }
      return listings;
    } catch (err) {
      this.logger.warn(`WeAreDevelopers: scrape failed: ${(err as Error).message}`);
      return [];
    }
  }

  protected normalizeData(item: WeAreDevelopersListing, _criteria: JobSourceCriteria): RawJobListing | null {
    if (!item.title || !item.link) return null;
    return {
      source: 'wearedevelopers',
      externalId: item.link,
      title: item.title,
      company: item.company,
      location: item.location,
      isRemote: item.isRemote,
      jobType: item.isRemote ? 'REMOTE' : 'CUSTOM',
      // The listing page doesn't carry a full description, and fetching every individual job page just to
      // get one would multiply requests per search. ensureDescription in JobsService backfills a short
      // factual summary for listings like this one.
      description: '',
      applyUrl: item.link,
    };
  }
}
