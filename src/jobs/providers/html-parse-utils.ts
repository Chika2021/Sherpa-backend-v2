/**
 * Small, dependency-free helpers for the scrapers in this folder that parse
 * raw HTML/RSS themselves (arc.dev's HTML fallback, myjobmag.com). This
 * project has no HTML-parsing library (cheerio, jsdom) installed today, so
 * these use plain regexes rather than a real DOM/XML parser.
 *
 * That's a deliberate trade-off, not an oversight: regex HTML parsing is
 * fragile against markup changes (see the warning in each scraper's own
 * file), but it keeps this ingestion layer dependency-free until a real
 * parser is actually needed for more than a couple of sources. If you add a
 * third or fourth scraped (non-headless) source, installing `cheerio` and
 * replacing these with real selector-based extraction is the better long-
 * term move - swap the implementation of these two functions and every
 * scraper that calls them keeps working unchanged.
 */

export function stripHtmlTags(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** One <item>...</item> (or <entry>...</entry> for Atom) block from an RSS/Atom feed, with its inner XML still raw. */
export function extractFeedItems(xml: string): string[] {
  const itemBlocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  if (itemBlocks.length) return itemBlocks;
  return xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
}

/** Pulls one tag's text content out of a raw XML/HTML fragment, unwrapping a CDATA section if present. */
export function extractTag(fragment: string, tag: string): string | undefined {
  const match = fragment.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return undefined;
  const raw = match[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return decodeHtmlEntities((cdata ? cdata[1] : raw).trim());
}

/** Pulls an attribute's value from the first tag matching `tag` in a fragment, e.g. `<link href="...">` in Atom feeds. */
export function extractAttr(fragment: string, tag: string, attr: string): string | undefined {
  const match = fragment.match(new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']+)["']`, 'i'));
  return match ? decodeHtmlEntities(match[1]) : undefined;
}
