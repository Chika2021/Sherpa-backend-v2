import { Logger } from '@nestjs/common';

/**
 * Makes the server's outbound HTTPS (Gemini, Paystack, ...) tolerant of slow
 * or flaky connections, and proxy-aware.
 *
 * Why this exists: Node's built-in fetch (undici) gives up on establishing a
 * connection after 10 seconds and ignores the HTTPS_PROXY environment
 * variable. On a slow, lossy or proxied network that shows up as a bare
 * "fetch failed" roughly 10s after every attempt - exactly the pattern of
 * "Error fetching from https://generativelanguage.googleapis.com/...: fetch
 * failed". Tuning it requires the `undici` package (Node doesn't expose the
 * built-in one's settings), so this is opt-in by installation:
 *
 *     npm i undici
 *
 * Without it the app runs exactly as before (and says so once at startup).
 *
 * Optional env vars:
 *   OUTBOUND_CONNECT_TIMEOUT_MS   connection timeout, default 30000
 *   HTTPS_PROXY / HTTP_PROXY      route outbound requests through a proxy
 */
export function configureOutboundNetwork(): void {
  const logger = new Logger('OutboundNetwork');

  let undici: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    undici = require('undici');
  } catch {
    logger.warn(
      'Optional package "undici" is not installed, so outbound requests use Node\'s defaults ' +
        '(10s connect timeout, no proxy support). If you see "fetch failed" errors from Gemini, run: npm i undici',
    );
    return;
  }

  const connectTimeout = Number(process.env.OUTBOUND_CONNECT_TIMEOUT_MS) || 30_000;
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

  try {
    // family: 4 belt-and-suspenders alongside main.ts's process-level
    // setDefaultAutoSelectFamily(false)/setDefaultResultOrder('ipv4first') -
    // this custom dispatcher replaces the GLOBAL fetch dispatcher for the
    // whole app, so it's worth it not to rely on only one layer skipping
    // IPv6 for every outbound call the app makes.
    const options = { connect: { timeout: connectTimeout, family: 4 as const }, keepAliveTimeout: 30_000 };
    const dispatcher = proxy ? new undici.ProxyAgent({ uri: proxy, ...options }) : new undici.Agent(options);
    undici.setGlobalDispatcher(dispatcher);
    logger.log(`Outbound HTTPS: ${connectTimeout}ms connect timeout, IPv4-only${proxy ? `, via proxy ${redact(proxy)}` : ''}.`);
  } catch (err) {
    logger.warn(`Could not configure outbound networking: ${(err as Error).message}`);
  }
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid proxy url)';
  }
}
