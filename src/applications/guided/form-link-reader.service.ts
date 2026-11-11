import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Frame, Page, chromium } from 'playwright';
import { FormField } from '../assisted/form-field.types';
import { inspectForm, readPageSummary } from '../assisted/form-inspector';
import { assertPublicHttpUrl, isPublicRequestUrl } from '../assisted/url-safety';

export interface ReadForm {
  url: string;
  title: string;
  siteName: string;
  /** Visible text of the page (capped) - used as job context and as a fallback when no fields were found. */
  text: string;
  /** Questions found on the live form (file uploads excluded - nothing to copy-paste). Empty if none were found. */
  fields: FormField[];
  /** How the page was read. */
  via: 'browser' | 'http';
}

const APPLY_BUTTON = /^\s*(easy )?apply( now| today| for this (job|role|position)| here)?\s*$/i;
const MAX_HTML_BYTES = 2_000_000;

/**
 * Reads an application-form link WITHOUT filling or submitting anything: it just lists the
 * questions on the page so the guided flow can answer them. Uses a headless browser (most ATS
 * forms render client-side) and falls back to a plain HTTP fetch if no browser is available.
 * Every request - including redirects and sub-requests - is held to the public internet.
 */
@Injectable()
export class FormLinkReader {
  private readonly logger = new Logger(FormLinkReader.name);
  private active = 0;
  private static readonly MAX_CONCURRENT = 2;

  async read(rawUrl: string): Promise<ReadForm> {
    const url = await assertPublicHttpUrl(rawUrl);
    if (this.active >= FormLinkReader.MAX_CONCURRENT) {
      throw new ServiceUnavailableException('Too many links are being read right now. Try again in a moment.');
    }
    this.active += 1;
    try {
      try {
        return await this.readWithBrowser(url);
      } catch (err) {
        this.logger.warn(`Browser read failed for ${url}, falling back to HTTP: ${(err as Error).message.split('\n')[0]}`);
        return await this.readWithHttp(url);
      }
    } finally {
      this.active -= 1;
    }
  }

  private async readWithBrowser(url: string): Promise<ReadForm> {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 900 }, locale: 'en-US' });
      await context.route('**/*', async (route) => {
        if (await isPublicRequestUrl(route.request().url())) return route.continue();
        return route.abort('blockedbyclient');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('dialog', (d) => void d.dismiss().catch(() => undefined));

      await this.load(page, url);
      let best = await this.bestFrame(page);

      // A listing page rather than the form itself: click "Apply" once and look again.
      if (best.count === 0) {
        const btn = page.locator('a, button').filter({ hasText: APPLY_BUTTON }).first();
        if (await btn.count().catch(() => 0)) {
          await btn.click({ timeout: 5000 }).catch(() => undefined);
          await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
          await page.waitForTimeout(1200);
          best = await this.bestFrame(page);
        }
      }

      const summary = await readPageSummary(page);
      const inspected = best.count ? await inspectForm(best.frame) : { fields: [] as FormField[], fileCount: 0 };
      const fields = inspected.fields.filter((f) => f.kind !== 'file').slice(0, 60);
      return { url, ...summary, fields, via: 'browser' };
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async load(page: Page, url: string) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    await page.waitForSelector('form, input, textarea', { state: 'attached', timeout: 12_000 }).catch(() => undefined);
    await page.waitForTimeout(1200); // iframe-embedded ATS widgets paint a beat later
  }

  /** The real form is often inside an iframe - use whichever frame has the most fields. */
  private async bestFrame(page: Page): Promise<{ frame: Frame; count: number }> {
    let best = { frame: page.mainFrame(), count: 0 };
    for (const frame of [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())]) {
      try {
        const count = await frame.locator('input:not([type=hidden]), textarea, select').count();
        if (count > best.count) best = { frame, count };
      } catch {
        // detached frame - ignore
      }
    }
    return best;
  }

  /** No-browser fallback: fetch the HTML (following redirects by hand so each hop is checked) and strip it to text. */
  private async readWithHttp(startUrl: string): Promise<ReadForm> {
    let url = startUrl;
    let html = '';
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(url, {
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobAssistant/1.0)', Accept: 'text/html,*/*' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = await assertPublicHttpUrl(new URL(res.headers.get('location')!, url).toString());
        continue;
      }
      if (!res.ok) throw new ServiceUnavailableException(`The site answered with HTTP ${res.status}. Paste the form text instead.`);
      html = (await res.text()).slice(0, MAX_HTML_BYTES);
      break;
    }
    if (!html) throw new ServiceUnavailableException("Couldn't read that page. Paste the form text instead.");

    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
    const siteName = html.match(/property=["']og:site_name["'][^>]*content=["']([^"']+)/i)?.[1] || '';
    const text = html
      .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/(p|div|li|label|h[1-6]|tr|br)>|<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim()
      .slice(0, 12_000);
    return { url, title, siteName, text, fields: [], via: 'http' };
  }
}
