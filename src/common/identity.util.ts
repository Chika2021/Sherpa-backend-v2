import * as crypto from 'crypto';

/**
 * The mailbox an address really delivers to, so "john+1@gmail.com", "j.o.h.n@gmail.com" and "John@gmail.com" are
 * recognised as one person. Used to catch self-referrals and free-token farming with email aliases.
 *  - lower-cased and trimmed
 *  - "+tag" stripped from the local part (works on Gmail, Outlook, iCloud, Proton, Fastmail...)
 *  - Gmail / Googlemail: dots in the local part are ignored too, and googlemail.com becomes gmail.com
 */
export function canonicalEmail(email: string): string {
  const clean = String(email ?? '').trim().toLowerCase();
  const at = clean.lastIndexOf('@');
  if (at < 1) return clean;
  let local = clean.slice(0, at);
  let domain = clean.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export function emailDomain(email: string): string {
  const clean = String(email ?? '').trim().toLowerCase();
  return clean.slice(clean.lastIndexOf('@') + 1);
}

/** "a***@g***.com" - enough for an admin or a friend list to recognise an address without exposing it. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = String(email ?? '').split('@');
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local.slice(0, 1)}***@${host.slice(0, 1)}***${tld}`;
}

/** "41.58.x.x" / "2a01:4b00:x:x" - the network part only. Raw IPs are never stored or shown. */
export function maskIp(ip: string | undefined | null): string {
  if (!ip) return 'unknown';
  const clean = ip.replace(/^::ffff:/, '');
  if (clean.includes('.')) return `${clean.split('.').slice(0, 2).join('.')}.x.x`;
  if (clean.includes(':')) return `${clean.split(':').slice(0, 2).join(':')}:x:x`;
  return 'unknown';
}

export interface RequestFingerprint {
  /** HMAC of the client IP (null when unknown). Used only to compare accounts - the IP itself is not stored. */
  ipHash: string | null;
  /** HMAC of the browser's X-Device-Id (null when the client did not send one). */
  deviceHash: string | null;
  /** Masked IP, safe to show an admin as evidence. */
  maskedIp: string;
}

/** Keyed hash so the stored values cannot be reversed or matched against another system. */
export function hashIdentifier(value: string | undefined | null, secret: string): string | null {
  const v = String(value ?? '').trim();
  if (!v || v === 'unknown') return null;
  return crypto.createHmac('sha256', secret).update(v).digest('hex').slice(0, 40);
}

/** Reads the caller's IP and device id from a request and returns the comparable (hashed) fingerprint. */
export function fingerprintOf(
  req: { headers?: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } } | undefined,
  secret: string,
): RequestFingerprint {
  const headers = req?.headers ?? {};
  const fwd = headers['x-forwarded-for'];
  const ip = ((Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req?.ip || req?.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const rawDevice = headers['x-device-id'];
  const device = (Array.isArray(rawDevice) ? rawDevice[0] : rawDevice)?.toString().slice(0, 100);
  return { ipHash: hashIdentifier(ip, secret), deviceHash: hashIdentifier(device, secret), maskedIp: maskIp(ip) };
}

/** A small, deliberately incomplete list of throwaway-mailbox domains. Extend it from your own abuse reports. */
export const DISPOSABLE_EMAIL_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com', '10minutemail.net',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmailo.com', 'throwawaymail.com', 'yopmail.com', 'yopmail.net',
  'getnada.com', 'nada.email', 'trashmail.com', 'trashmail.net', 'dispostable.com', 'maildrop.cc', 'mailnesia.com',
  'fakeinbox.com', 'mohmal.com', 'emailondeck.com', 'moakt.com', 'spamgourmet.com', 'mintemail.com', 'mytemp.email',
  'tmpmail.org', 'tmpmail.net', 'burnermail.io', 'discard.email', 'mailcatch.com', 'inboxkitten.com', 'harakirimail.com',
]);
