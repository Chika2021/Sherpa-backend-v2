import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * The assisted-apply flow makes the *server* open a URL that a user typed in.
 * Without a guard, that's a classic SSRF hole: someone could paste
 * http://169.254.169.254/... (cloud metadata), http://localhost:27017, or an
 * internal admin panel and have the server's headless browser fetch it and
 * hand back a screenshot. Everything here exists to make sure the browser can
 * only ever reach the public internet.
 */

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, incl. cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast / reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d). WHATWG URL rewrites these to the hex form
  // (::ffff:7f00:1), so both spellings have to be understood.
  const dotted = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // Any other ::-prefixed form (IPv4-compatible, etc.) and the NAT64 range are not something a job site needs.
  if (v.startsWith('::') || v.startsWith('64:ff9b:')) return true;
  return (
    v.startsWith('fc') || // fc00::/7 unique local
    v.startsWith('fd') ||
    v.startsWith('fe8') || // fe80::/10 link-local
    v.startsWith('fe9') ||
    v.startsWith('fea') ||
    v.startsWith('feb') ||
    v.startsWith('ff') // multicast
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not an IP at all - treat as unsafe
}

const hostCache = new Map<string, { ok: boolean; at: number }>();
const HOST_CACHE_MS = 60_000;

async function hostIsPublic(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (isIP(host)) return !isPrivateAddress(host);

  const cached = hostCache.get(host);
  if (cached && Date.now() - cached.at < HOST_CACHE_MS) return cached.ok;

  let ok = false;
  try {
    const addrs = await lookup(host, { all: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address));
  } catch {
    ok = false;
  }
  hostCache.set(host, { ok, at: Date.now() });
  if (hostCache.size > 500) hostCache.clear();
  return ok;
}

/**
 * Parses and validates a user-supplied link. Adds https:// if the user pasted
 * a bare domain. Throws a 400 for anything that isn't a public http(s) URL.
 */
export async function assertPublicHttpUrl(raw: string): Promise<string> {
  const trimmed = (raw || '').trim();
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new BadRequestException('That does not look like a valid link.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Only http(s) links can be used.');
  }
  if (url.username || url.password) {
    throw new BadRequestException('Links containing a username/password are not supported.');
  }
  if (!(await hostIsPublic(url.hostname))) {
    throw new BadRequestException('That link points to a private or unreachable address.');
  }
  return url.toString();
}

/**
 * Same check, boolean form, for the browser's per-request route guard: covers
 * redirects and sub-requests, not just the URL the user pasted. (Chromium does
 * its own DNS lookup afterwards, so a hostile DNS server could still race
 * this; for a stronger guarantee run the browser in a network namespace/egress
 * proxy that blocks private ranges.)
 */
export async function isPublicRequestUrl(rawUrl: string): Promise<boolean> {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true; // data:, blob:, about: never hit the network
    return await hostIsPublic(url.hostname);
  } catch {
    return false;
  }
}
