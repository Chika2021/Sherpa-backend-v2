import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResumeProfile } from '../../ai/gemini.service';
import { BaseJobScraper } from './base-job-scraper';
import { JobSourceCriteria, RawJobListing } from './job-source.interface';
import { absoluteUrl, fetchCheerio, jsonLdJobPostings, textOf } from './html-scraper.util';

const DEFAULT_LISTING_URL = 'https://contra.com/opportunities';
const CACHE_TTL_MS = 30 * 60_000;

interface ContraListing {
  title: string;
  client?: string;
  link: string;
  rateText?: string;
}

/**
 * Scrapes Contra's freelance "opportunities" board (contra.com/opportunities) with plain `fetch` + Cheerio.
 *
 * Contra is a freelance marketplace rather than a traditional job board, so everything maps to jobType
 * FREELANCE and a rate string is read into `salary`.
 *
 * IMPORTANT: Cheerio does not run JavaScript - it only sees the HTML the server returns. Contra is a
 * client-rendered app, so listings only appear here if they are in that initial HTML (server-rendered cards or
 * JobPosting JSON-LD, both tried below). Otherwise the provider logs a clear "0 listings" warning and returns
 * nothing. Same selector-fragility caveat as the WeAreDevelopers provider.
 *
 * Contra's Opportunities board is behind a Contra Pro login and client-rendered, so a plain fetch normally
 * sees no listings. This source is therefore OFF by default (like WeAreDevelopers).
 *
 * Env vars:
 *   CONTRA_ENABLED - set to "true" to turn this source on.
 *   CONTRA_LISTING_URL - optional, override the page URL.
 */
@Injectable()
export class ContraJobSourceProvider extends BaseJobScraper<ContraListing> {
  readonly name = 'contra';
  protected readonly logger = new Logger(ContraJobSourceProvider.name);
  private readonly enabled: boolean;
  private readonly listingUrl: string;
  private warnedDisabled = false;
  private cache: { fetchedAt: number; listings: ContraListing[] } | null = null;
  private inFlight: Promise<ContraListing[]> | null = null;

  constructor(config: ConfigService) {
    super();
    this.enabled = config.get<string>('CONTRA_ENABLED') === 'true';
    this.listingUrl = config.get<string>('CONTRA_LISTING_URL') || DEFAULT_LISTING_URL;
  }

  protected async fetchRawData(_criteria: JobSourceCriteria, _profile: ResumeProfile): Promise<ContraListing[]> {
    if (!this.enabled) {
      if (!this.warnedDisabled) {
        this.logger.log('CONTRA_ENABLED is not "true" - skipping the Contra source (its job board needs a Pro login). Other sources still run.');
        this.warnedDisabled = true;
      }
      return [];
    }
    if (this.cache && Date.now() - this.cache.fetchedAt < CACHE_TTL_MS) return this.cache.listings;
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

  private async scrape(): Promise<ContraListing[]> {
    try {
      const $ = await fetchCheerio(this.listingUrl, this.logger, 'Contra');

      const fromJsonLd = jsonLdJobPostings($)
        .map((j): ContraListing | null => {
          const link = absoluteUrl(j.url, this.listingUrl);
          if (!j.title || !link) return null;
          const salary = j.baseSalary?.value;
          const rateText =
            salary && typeof salary === 'object' && salary.value
              ? `${salary.value} ${j.baseSalary?.currency ?? ''} ${salary.unitText ?? ''}`.trim()
              : undefined;
          return { title: String(j.title).trim(), client: j.hiringOrganization?.name || undefined, link, rateText };
        })
        .filter((l): l is ContraListing => !!l);

      const fromCards: ContraListing[] = [];
      $('[data-testid="opportunity-card"], .opportunity-card, article').each((_i, el) => {
        const card = $(el);
        const link = absoluteUrl(
          card.find('a[href*="/opportunities/"], a[href*="/opportunity/"]').first().attr('href'),
          this.listingUrl,
        );
        const title = textOf(card.find('h2, h3, [data-testid="opportunity-title"]').first());
        if (!link || !title) return;
        fromCards.push({
          title,
          client: textOf(card.find('[data-testid="client-name"], .client-name').first()) || undefined,
          link,
          rateText: textOf(card.find('[data-testid="rate"], .rate').first()) || undefined,
        });
      });

      const byLink = new Map<string, ContraListing>();
      for (const l of [...fromJsonLd, ...fromCards]) if (!byLink.has(l.link)) byLink.set(l.link, l);
      const listings = [...byLink.values()];

      if (listings.length === 0) {
        this.logger.warn(
          'Contra: 0 listings found in the raw HTML - the page is probably rendered client-side (Cheerio does not run JavaScript), has no openings, or changed its markup. Update the selectors in contra.provider.ts or switch to a JSON endpoint.',
        );
      }
      return listings;
    } catch (err) {
      this.logger.warn(`Contra: scrape failed: ${(err as Error).message}`);
      return [];
    }
  }

  protected normalizeData(item: ContraListing, _criteria: JobSourceCriteria): RawJobListing | null {
    if (!item.title || !item.link) return null;
    return {
      source: 'contra',
      externalId: item.link,
      title: item.title,
      company: item.client,
      isRemote: true, // Contra is a remote freelance marketplace end-to-end
      jobType: 'FREELANCE',
      description: '', // backfilled by JobsService.ensureDescription - see WeAreDevelopers provider for the same trade-off
      applyUrl: item.link,
      salary: item.rateText,
    };
  }
}
