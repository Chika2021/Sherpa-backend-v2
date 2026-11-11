import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';

/** Tiny in-memory sliding-window limiter for the public endpoints (contact form, chatbot). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly max: number, private readonly windowMs: number) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  check(key: string): void {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      throw new HttpException('Too many requests - please slow down and try again shortly.', HttpStatus.TOO_MANY_REQUESTS);
    }
    recent.push(now);
    this.hits.set(key, recent);
  }

  private sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) {
      const recent = v.filter((t) => now - t < this.windowMs);
      if (recent.length) this.hits.set(k, recent);
      else this.hits.delete(k);
    }
  }
}

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.ip || req.socket?.remoteAddress || 'unknown';
}
