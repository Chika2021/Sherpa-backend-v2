/**
 * Turns whatever an admin pastes into the "job links for this country" box into a clean list of links.
 *
 * Accepts links separated by new lines, spaces, tabs, commas or semicolons; bullets and numbering ("1.", "-", "•");
 * markdown links ([label](url)); and rows copied from a spreadsheet (words that are not links are ignored).
 * Links without a scheme ("www.jobberman.com/jobs/1" or "jobberman.com/jobs/1") get https://.
 *
 * Only http(s) links to a real hostname are kept. Anything else (javascript:, ftp:, localhost, IP addresses,
 * links with a user:password@ part) is reported back as invalid and never stored.
 */

export const MAX_LINKS_PER_BOARD = 1000;
const MAX_URL_LENGTH = 2048;
const MAX_INVALID_REPORTED = 50;

const TRACKING_PARAM = /^(utm_.+|fbclid|gclid|msclkid|mc_cid|mc_eid|igshid)$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCHEME_LESS = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i;
const REAL_TLD = /\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/i;

export interface ParsedLinks {
  /** Valid, normalised, de-duplicated links in the order they were pasted. */
  links: string[];
  /** Pasted entries that looked like links but were refused (capped at 50, each cut to 200 chars). */
  invalid: string[];
  invalidCount: number;
  /** How many pasted links were repeats of one already seen in the same paste. */
  duplicates: number;
}

/** Identity used to compare links: same link with or without a trailing slash is the same link. */
export const linkKey = (url: string): string => url.replace(/\/+$/, '');

/** Returns the cleaned link, or null if it is not an acceptable http(s) link. */
export function normalizeLink(candidate: string): string | null {
  let text = candidate;
  if (!HAS_SCHEME.test(text)) {
    // Without a scheme, only accept what is clearly a web address ("www." or a path), so stray words such
    // as "file.txt" are not mistaken for links.
    if (!SCHEME_LESS.test(text) || !(/^www\./i.test(text) || text.includes('/'))) return null;
    text = `https://${text}`;
  }
  if (text.length > MAX_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null; // "https://trusted.com@evil.com" style tricks
  const host = url.hostname;
  if (!host.includes('.') || IPV4.test(host) || host.startsWith('[') || !REAL_TLD.test(host)) return null;

  // Drop the fragment, except where it is how a single-page job board routes ("#/jobs/42").
  if (url.hash && !/^#[/!]/.test(url.hash)) url.hash = '';
  // Strip tracking parameters, but only touch the query string when there is something to strip, so
  // untouched links keep their exact original encoding.
  const tracked = [...url.searchParams.keys()].filter((k) => TRACKING_PARAM.test(k));
  if (tracked.length) for (const k of new Set(tracked)) url.searchParams.delete(k);

  let out = url.toString();
  if (url.pathname === '/' && !url.search && !url.hash) out = out.replace(/\/$/, '');
  return out.length > MAX_URL_LENGTH ? null : out;
}

function cleanToken(piece: string): string {
  return piece
    .replace(/^[\s<(["'`\u2018\u201C*\u2022\u00B7\-\u2013\u2014]+/, '')
    .replace(/[>)\]}"'`\u2019\u201D,;.:!?]+$/, '');
}

export function parseLinkBlock(input: string): ParsedLinks {
  // [label](https://x) -> https://x
  const text = String(input ?? '').replace(/\[[^\]]*\]\(([^)\s]+)\)/g, ' $1 ');
  const found = new Map<string, string>();
  const invalid: string[] = [];
  let invalidCount = 0;
  let duplicates = 0;

  for (const rawToken of text.split(/\s+/)) {
    // "https://a.com/1,https://a.com/2" -> two links; a comma inside a link is left alone.
    for (const piece of rawToken.split(/[,;|]+(?=(?:[a-z][a-z0-9+.-]*:\/\/|www\.))/i)) {
      const token = cleanToken(piece);
      // Skip bullets, list numbers and plain words (titles/notes copied from a spreadsheet row).
      if (!token || /^\d+[.)]?$/.test(token) || !/[./:]/.test(token)) continue;

      const link = normalizeLink(token);
      if (!link) {
        invalidCount++;
        const shown = token.slice(0, 200);
        if (invalid.length < MAX_INVALID_REPORTED && !invalid.includes(shown)) invalid.push(shown);
        continue;
      }
      const key = linkKey(link);
      if (found.has(key)) duplicates++;
      else found.set(key, link);
    }
  }
  return { links: [...found.values()], invalid, invalidCount, duplicates };
}
