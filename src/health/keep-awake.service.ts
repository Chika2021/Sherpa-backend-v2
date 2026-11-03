import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_INTERVAL_MINUTES = 10; // Render's free tier sleeps a service after 15 minutes without traffic
const FIRST_PING_DELAY_MS = 60_000; // give the server time to start listening

/**
 * Stops a Render free-tier web service from spinning down by sending itself a request
 * through its own public URL on a schedule.
 *
 *   RENDER_EXTERNAL_URL         set automatically by Render - nothing to configure there.
 *   KEEP_AWAKE_URL              optional: ping this base URL instead (any host).
 *   KEEP_AWAKE                  "false" turns it off. Default: on whenever a URL is known.
 *   KEEP_AWAKE_INTERVAL_MINUTES default 10 (minimum 1, keep it under 15 on Render).
 *
 * Does nothing when no URL is available (e.g. local development).
 *
 * It cannot wake a service that is ALREADY asleep (a sleeping service runs no code), and a free
 * Render account has a monthly hour allowance, so for a guarantee also point an external monitor at
 * GET /api/v1/health (see POSTGRES_MIGRATION.md).
 */
@Injectable()
export class KeepAwakeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('KeepAwake');
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const setting = (this.config.get<string>('KEEP_AWAKE') ?? 'true').trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(setting)) {
      this.logger.log('Keep-awake ping is OFF (KEEP_AWAKE=false).');
      return;
    }

    const base = (this.config.get<string>('KEEP_AWAKE_URL') || this.config.get<string>('RENDER_EXTERNAL_URL') || '')
      .trim()
      .replace(/\/+$/, '');
    if (!base) return; // not on Render (and no override): nothing to keep awake

    const minutes = Number(this.config.get<string>('KEEP_AWAKE_INTERVAL_MINUTES'));
    const intervalMinutes = Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_INTERVAL_MINUTES;
    const url = `${base}/api/v1/health`;

    this.first = setTimeout(() => void this.ping(url), FIRST_PING_DELAY_MS);
    this.timer = setInterval(() => void this.ping(url), intervalMinutes * 60_000);
    this.first.unref();
    this.timer.unref(); // never keeps the process alive on its own
    this.logger.log(`Keep-awake ON - pinging ${url} every ${intervalMinutes} minute(s).`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One request to our own public URL. Never throws. */
  async ping(url: string): Promise<boolean> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) {
        this.logger.warn(`Keep-awake ping got HTTP ${res.status} from ${url}`);
        return false;
      }
      return true; // success is silent: it runs every few minutes and would only fill the logs
    } catch (err) {
      this.logger.warn(`Keep-awake ping failed: ${(err as Error).message}`);
      return false;
    }
  }
}
