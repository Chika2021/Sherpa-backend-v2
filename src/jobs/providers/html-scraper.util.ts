import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';

export type CheerioAPI = cheerio.CheerioAPI;

const FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/**
 * Fetches a page's raw HTML and loads it into Cheerio (jQuery-style selectors on the server).
 * Replaces the old headless-Chromium helper: no browser is launched and no JavaScript is executed,
 * so this only sees what the server sends in the initial HTML response (including data embedded in
 * <script> tags such as __NEXT_DATA__ or JSON-LD, see the helpers below).
 */
export async function fetchCheerio(url: string, logger: Logger, label: string): Promise<CheerioAPI> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': DEFAULT_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`.trim());
    return cheerio.load(await res.text());
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`${label}: request timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
    }
    logger.debug(`${label}: fetch failed: ${(err as Error).message}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Absolute URL for an href found on a page (hrefs are often relative). Returns '' if it can't be resolved. */
export function absoluteUrl(href: string | undefined, base: string): string {
  if (!href) return '';
  try {
    return new URL(href, base).toString();
  } catch {
    return '';
  }
}

/** Trimmed, whitespace-collapsed text of a Cheerio selection ('' if empty). */
export function textOf(sel: { text(): string }): string {
  return sel.text().replace(/\s+/g, ' ').trim();
}

/** Every schema.org JobPosting object found in the page's <script type="application/ld+json"> blocks. */
export function jsonLdJobPostings($: CheerioAPI): any[] {
  const found: any[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = node['@type'];
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) found.push(node);
    if (node['@graph']) visit(node['@graph']);
    if (node.itemListElement) visit(node.itemListElement);
    if (node.item) visit(node.item);
  };
  $('script[type="application/ld+json"]').each((_i, el) => {
    try {
      visit(JSON.parse($(el).contents().text()));
    } catch {
      /* ignore malformed JSON-LD */
    }
  });
  return found;
}
