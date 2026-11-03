/**
 * Shared low-level fetch used by every free public job-board provider
 * (Remotive, RemoteOK, Arbeitnow, Jobicy, Adzuna). All of these are
 * independent third-party APIs on different hosts, yet in practice they tend
 * to fail together, at the same moment, with the same generic message:
 *
 *   "This operation was aborted"
 *
 * That's `AbortController.abort()` firing because a `fetch` call neither
 * succeeded nor failed before the timeout - which almost always means the
 * TCP connection itself never completed (packets silently dropped) rather
 * than any one of these services genuinely being slow. Several unrelated
 * hosts hanging identically at once is the signature of an outbound-network
 * restriction on the server this runs on (a firewall/security-group egress
 * rule, a required HTTPS_PROXY that isn't configured, or no internet egress
 * at all) - not a bug in any individual provider, and not something retrying
 * harder can fix.
 *
 * What this helper actually does about it:
 *  - One retry after a short backoff, in case it's a transient blip (a public
 *    rate limit, a brief outage) rather than a hard block.
 *  - Replaces the unhelpful generic abort message with one that names the
 *    actual host and timeout, and points at the likely cause and a concrete
 *    way to verify it (`curl -v <url>` from the same server), so the log
 *    alone is enough to tell "network problem" from "API problem" instead of
 *    everyone re-diagnosing this from scratch every time it happens.
 *
 * See `../../config/outbound-network.ts` for the app-wide connect-timeout /
 * proxy configuration this complements - that fixes the *symptom* (Node's
 * default timeout, no proxy support) for every outbound call in the app;
 * this fixes the *diagnosis* specifically for these four/five providers.
 */
export interface FetchJsonOptions {
  /** Per-attempt timeout. Default 12s - generous for a small public JSON feed. */
  timeoutMs?: number;
  /** Additional attempts after the first. Default 1 (i.e. try twice total). */
  retries?: number;
  /** Human name used in error/log messages, e.g. "Remotive". */
  label: string;
  init?: RequestInit;
}

export async function fetchJsonWithRetry<T = any>(url: string, opts: FetchJsonOptions): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const retries = opts.retries ?? 1;
  const host = safeHost(url);
  let lastErr: Error = new Error(`${opts.label}: request failed`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...(opts.init || {}), signal: controller.signal });
      if (!res.ok) throw new Error(`${opts.label} responded HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (err) {
      lastErr = describeError(err, opts.label, host, timeoutMs, url);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Same retry/timeout/diagnostics behavior as `fetchJsonWithRetry`, but for
 * sources that return HTML or XML/RSS rather than JSON (arc.dev's feed) -
 * used by scrapers that parse text themselves instead of getting a
 * ready-made object back. Also surfaces the HTTP status on a 429
 * specifically (`.status` on the thrown error) so callers can back off
 * politely instead of hammering a rate-limited page.
 */
export async function fetchTextWithRetry(url: string, opts: FetchJsonOptions): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const retries = opts.retries ?? 1;
  const host = safeHost(url);
  let lastErr: Error = new Error(`${opts.label}: request failed`);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...(opts.init || {}), signal: controller.signal });
      if (!res.ok) {
        const err: any = new Error(`${opts.label} responded HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.text();
    } catch (err) {
      lastErr = describeError(err, opts.label, host, timeoutMs, url);
      (lastErr as any).status = (err as any)?.status;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function describeError(err: unknown, label: string, host: string, timeoutMs: number, url: string): Error {
  const isAbort = (err as any)?.name === 'AbortError';
  if (!isAbort) return err as Error;
  return new Error(
    `${label}: connection to ${host} did not complete within ${timeoutMs}ms. This is almost always an ` +
      `outbound-network restriction on this server (a firewall/security-group egress rule, a required ` +
      `HTTPS_PROXY that isn't set, or no internet access at all) rather than ${label} itself being slow - ` +
      `especially if other, unrelated hosts fail the same way at the same time. Verify from this same server ` +
      `with: curl -v ${url}`,
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
