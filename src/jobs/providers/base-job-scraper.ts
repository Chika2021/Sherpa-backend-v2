import { Logger } from '@nestjs/common';
import { ResumeProfile } from '../../ai/gemini.service';
import { JobSourceCriteria, JobSourceProvider, MAX_LISTING_AGE_DAYS, RawJobListing } from './job-source.interface';
import { dedupeRawListings } from '../utils/deduplicate-listings';

/**
 * Common base for every job-ingestion source in this codebase (API-backed or
 * scraped). It implements `JobSourceProvider.search()` once, in terms of two
 * methods every concrete subclass must supply:
 *
 *   - `fetchRawData(criteria)`  - get whatever the source hands back, in its
 *     own native shape (a parsed JSON body, an array of RSS items, an array
 *     of DOM/Cheerio elements scraped off a page - anything). This is the
 *     ONLY method that should know how to talk to the source at all (HTTP
 *     call, RSS parse, headless-browser page load).
 *   - `normalizeData(item, criteria)` - turn ONE raw item from that shape
 *     into this app's own `RawJobListing`, or return `null` to drop it (not
 *     a real job posting, missing a required field, etc). This is the ONLY
 *     method that should know this app's own listing shape.
 *
 * `search()` itself then applies every cross-cutting rule every source
 * needs, so no individual scraper has to remember to do it:
 *   - Freshness: anything older than `MAX_LISTING_AGE_DAYS` is dropped -
 *     matches every other JobSourceProvider in this codebase (see
 *     job-source.interface.ts).
 *   - Dedup: `dedupeRawListings` collapses same-source duplicates a single
 *     fetch can produce (pagination overlap, a listing cross-posted to two
 *     categories on the same site, etc) before the result ever reaches
 *     `JobsService.collectRealListings`, which separately dedupes ACROSS
 *     sources once everything is pooled.
 *   - Isolation: any error thrown by `fetchRawData` (network, parse) is
 *     caught, logged, and turned into an empty result rather than failing
 *     the whole search - one source misbehaving must never take down every
 *     other one JobsService queries in parallel.
 *
 * Concrete subclasses stay in `providers/`, get added to `JobsModule`'s
 * providers array, and get passed into `JobsService`'s constructor exactly
 * like the existing Remotive/RemoteOK/Arbeitnow/Jobicy/Adzuna providers -
 * this class does not change how a source is wired in, only how much
 * boilerplate each new one has to write.
 */
export abstract class BaseJobScraper<TRawItem = any> implements JobSourceProvider {
  abstract readonly name: string;
  protected abstract readonly logger: Logger;

  /**
   * Fetch whatever this source has to offer for these criteria, in its own
   * native shape. Throw on failure (network, HTTP error, unexpected
   * response shape) - `search()` catches it, so subclasses don't need their
   * own top-level try/catch here. Sources that can push filtering
   * server-side (a `?q=` query param, a location filter) should still do
   * so - it's just fewer items for `normalizeData`/the freshness filter to
   * discard - but nothing downstream depends on that; `search()`'s own
   * filtering is what's actually relied on.
   */
  protected abstract fetchRawData(criteria: JobSourceCriteria, profile: ResumeProfile): Promise<TRawItem[]>;

  /**
   * Convert one native item into this app's `RawJobListing`, or `null` if
   * it isn't a usable listing (e.g. a scraped DOM node that turned out to
   * be a "sponsored" banner, not an actual posting, or a required field -
   * title, applyUrl - is missing/unparseable).
   */
  protected abstract normalizeData(item: TRawItem, criteria: JobSourceCriteria): RawJobListing | null;

  async search(profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]> {
    let rawItems: TRawItem[];
    try {
      rawItems = await this.fetchRawData(criteria, profile);
    } catch (err) {
      this.logger.warn(`${this.name}: fetch failed, skipping this source: ${(err as Error).message}`);
      return [];
    }

    const oldestAllowed = Date.now() - MAX_LISTING_AGE_DAYS * 24 * 60 * 60_000;
    const listings: RawJobListing[] = [];
    for (const item of rawItems) {
      let listing: RawJobListing | null;
      try {
        listing = this.normalizeData(item, criteria);
      } catch (err) {
        // One malformed item (an unexpected null field, a date the source
        // formatted oddly) should cost us that one listing, not the whole
        // batch this fetch otherwise successfully returned.
        this.logger.debug(`${this.name}: dropping one item that failed to normalize: ${(err as Error).message}`);
        continue;
      }
      if (!listing || !listing.title || !listing.applyUrl) continue;
      // A source with no posted-date at all is kept (we can't judge its
      // freshness, so we don't penalize it); one with a date is dropped if
      // that date is stale - same rule every other provider in this
      // codebase applies.
      if (listing.postedAt && listing.postedAt.getTime() < oldestAllowed) continue;
      listings.push({ ...listing, source: listing.source || this.name });
    }

    return dedupeRawListings(listings);
  }
}
