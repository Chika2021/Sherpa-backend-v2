import { Repository } from 'typeorm';
import { Job } from '../../entities/job.entity';
import { escapeLike } from '../../database/db-utils';
import { RawJobListing } from '../providers/job-source.interface';

/**
 * Two different "is this a duplicate?" questions come up in job ingestion,
 * and this file answers both the same way (same normalization, same
 * matching rule) so a job can't slip through one check by phrasing itself
 * slightly differently than the other:
 *
 *   1. In-memory, across a batch of freshly-fetched listings (either from
 *      one source's own pagination/categories overlapping, or from several
 *      sources being pooled together) - `dedupeRawListings`.
 *   2. Against what's already in the database, right before persisting a
 *      new one - `jobAlreadyExists`.
 *
 * Matching happens on two independent keys, either of which is enough to
 * call two listings the same job:
 *   - EXACT `applyUrl` (after trimming a trailing slash and a `?utm_...`/
 *     tracking query string, which otherwise makes the same URL look
 *     different every time a source re-shares it). This is the strong
 *     signal: the same posting, byte-for-byte the same destination.
 *   - Normalized `title` + `company` (lowercased, punctuation/whitespace
 *     collapsed) posted within a short window of each other. This is what
 *     catches the SAME real-world opening cross-posted to two different
 *     platforms with two different URLs - e.g. a role listed on both
 *     4dayweek.io and a company's own site, or syndicated to both
 *     web3.career and LinkedIn - which `applyUrl` alone would never catch.
 */

// How close two postings' dates need to be to still count as "the same
// listing, cross-posted" once title+company already match. Wide enough to
// cover a listing appearing on a second platform a few days after the
// first, narrow enough that two genuinely different hiring rounds for a
// common title ("Senior Backend Engineer" at a large company) months apart
// aren't wrongly merged.
const CROSS_POST_WINDOW_DAYS = 5;

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Strip tracking/query noise that doesn't change the destination -
    // utm_*, ref, source, etc - so the same posting re-shared with a fresh
    // tracking tag still matches. Kept deliberately conservative (drop
    // everything) since applyUrl query strings on these sources never carry
    // information needed to actually reach the posting.
    u.search = '';
    u.hash = '';
    let path = u.pathname.replace(/\/+$/, '');
    return `${u.host.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normalizeTitleCompany(title: string, company?: string): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  return `${clean(title)}|${clean(company || '')}`;
}

/**
 * Collapses duplicates within a single in-memory batch of listings (one
 * source's own fetch, or several sources' results already pooled together).
 * Keeps the FIRST occurrence of each duplicate group, so callers that sort
 * by recency/relevance before deduping keep the best copy.
 */
export function dedupeRawListings(listings: RawJobListing[]): RawJobListing[] {
  const seenUrls = new Set<string>();
  // Bucketed by normalized title+company so a same-day duplicate is found
  // in O(1); the small list per bucket is only compared against for the
  // cross-post date window, not the whole result set.
  const seenByTitleCompany = new Map<string, RawJobListing[]>();
  const result: RawJobListing[] = [];

  for (const listing of listings) {
    const urlKey = normalizeUrl(listing.applyUrl);
    if (urlKey && seenUrls.has(urlKey)) continue;

    const titleCompanyKey = normalizeTitleCompany(listing.title, listing.company);
    const bucket = seenByTitleCompany.get(titleCompanyKey);
    if (bucket && isCrossPostDuplicate(bucket, listing)) continue;

    if (urlKey) seenUrls.add(urlKey);
    if (bucket) bucket.push(listing);
    else seenByTitleCompany.set(titleCompanyKey, [listing]);
    result.push(listing);
  }

  return result;
}

function isCrossPostDuplicate(existing: RawJobListing[], candidate: RawJobListing): boolean {
  if (!candidate.postedAt) {
    // No date to compare - if title+company already matched, that alone is
    // a strong enough signal (a generic title with no company, e.g. an
    // anonymized posting, would still need `company` to match, which is
    // already folded into the bucket key).
    return existing.length > 0 && !!candidate.company;
  }
  const windowMs = CROSS_POST_WINDOW_DAYS * 24 * 60 * 60_000;
  return existing.some((e) => {
    if (!candidate.company) return false; // never merge on title alone
    if (!e.postedAt) return true;
    return Math.abs(e.postedAt.getTime() - candidate.postedAt!.getTime()) <= windowMs;
  });
}

/**
 * Checks the database for a job that already represents this same real-world
 * posting - called right before persisting a newly-ingested listing so the
 * same opening surfaced by two different sources (or refetched by the same
 * source on a later run) doesn't create a second row. Mirrors the two-key
 * rule above: an exact (normalized) `applyUrl` match, or a normalized
 * title+company match posted within `CROSS_POST_WINDOW_DAYS` of this one.
 *
 * Returns the matched document (or null) rather than a plain boolean: the
 * caller doesn't just want to know "is this a duplicate?" - when it is, the
 * caller needs the EXISTING job so it can still surface it in this search's
 * results (see JobsService.search, which attaches a JobSearchResult to
 * whatever this returns instead of silently dropping the ranked listing).
 * `JobsService.search()` itself persists new listings via
 * an upsert on the unique (source, externalId, applyUrl) key,
 * which already prevents a literal re-fetch of the SAME source's SAME
 * listing from duplicating - this function is what additionally catches the
 * cross-platform case that upsert-by-source-key cannot.
 */
export async function findDuplicateJob(
  jobRepo: Repository<Job>,
  listing: RawJobListing,
  options?: {
    // When set, only an existing row from THIS SAME source counts as a
    // duplicate - a match from a different source is ignored. Set this when
    // the caller is running a search restricted to one named source (the
    // "Search source" filter in the UI): a user who explicitly asked for
    // "just Adzuna" results wants to see everything Adzuna has, even if the
    // same real-world opening also happens to be saved under a different
    // source from an earlier, unrestricted search - hiding it there would
    // make the filter look broken (an Adzuna listing silently missing from
    // "Adzuna only" results because of a source the user didn't ask to see).
    // Leave unset for the normal, unrestricted multi-source search, where
    // collapsing the same opening across sources is exactly the point.
    restrictToSource?: string;
  },
): Promise<Job | null> {
  const restrictToSource = options?.restrictToSource;
  const urlKey = normalizeUrl(listing.applyUrl);

  // NOTE: TypeORM silently drops a condition whose value is `undefined`, so every
  // optional value below is checked before it goes into a query.
  if (listing.applyUrl) {
    const byUrl = await jobRepo.findOne({
      where: { applyUrl: listing.applyUrl, ...(restrictToSource ? { source: restrictToSource } : {}) },
    });
    if (byUrl) return byUrl;
  }

  // applyUrl in the DB may have been stored with a different tracking query
  // string than this listing's - fall back to a "contains host+path" scan
  // when the exact string didn't match. Cheap enough at this table's scale;
  // revisit with a normalizedUrl column + index if this table grows large.
  if (urlKey && listing.applyUrl) {
    const qb = jobRepo
      .createQueryBuilder('j')
      .where('j.applyUrl ILIKE :pattern', { pattern: `%${escapeLike(hostAndPath(listing.applyUrl))}%` });
    if (restrictToSource) qb.andWhere('j.source = :source', { source: restrictToSource });
    const candidates = await qb.limit(5).getMany();
    const match = candidates.find((c) => normalizeUrl(c.applyUrl) === urlKey);
    if (match) return match;
  }

  if (!listing.company) return null;
  const windowStart = listing.postedAt
    ? new Date(listing.postedAt.getTime() - CROSS_POST_WINDOW_DAYS * 24 * 60 * 60_000)
    : undefined;
  const windowEnd = listing.postedAt
    ? new Date(listing.postedAt.getTime() + CROSS_POST_WINDOW_DAYS * 24 * 60 * 60_000)
    : undefined;

  // Case-insensitive exact company match.
  const companyQb = jobRepo
    .createQueryBuilder('j')
    .where('LOWER(j.company) = LOWER(:company)', { company: listing.company.trim() });
  if (windowStart && windowEnd) {
    companyQb.andWhere('j.postedAt >= :windowStart AND j.postedAt <= :windowEnd', { windowStart, windowEnd });
  }
  if (restrictToSource) companyQb.andWhere('j.source = :source', { source: restrictToSource });
  const sameCompanyRecent = await companyQb.limit(20).getMany();

  const candidateKey = normalizeTitleCompany(listing.title, listing.company);
  return sameCompanyRecent.find((j) => normalizeTitleCompany(j.title, j.company) === candidateKey) || null;
}

/** Convenience boolean wrapper around {@link findDuplicateJob} for callers that only need a yes/no. */
export async function jobAlreadyExists(
  jobRepo: Repository<Job>,
  listing: RawJobListing,
  options?: { restrictToSource?: string },
): Promise<boolean> {
  return (await findDuplicateJob(jobRepo, listing, options)) !== null;
}

function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url;
  }
}
