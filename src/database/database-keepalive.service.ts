import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const DEFAULT_INTERVAL_HOURS = 6;

/**
 * Keeps a Supabase free-tier project from being paused for inactivity (it pauses after about
 * 7 days with no activity) by running a tiny query against the database on a schedule.
 *
 *   DB_KEEPALIVE                 "false" turns it off. Default: on.
 *   DB_KEEPALIVE_INTERVAL_HOURS  how often to ping (default 6, minimum 0.1).
 *
 * It only runs while this app is running. If your host puts the app to sleep when idle
 * (e.g. a free Render/Railway plan), the pings stop too - see POSTGRES_MIGRATION.md for an
 * external scheduler that works regardless.
 */
@Injectable()
export class DatabaseKeepAliveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DatabaseKeepAlive');
  private timer?: NodeJS.Timeout;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const setting = (this.config.get<string>('DB_KEEPALIVE') ?? 'true').trim().toLowerCase();
    if (['false', '0', 'no', 'off'].includes(setting)) {
      this.logger.log('Database keep-alive is OFF (DB_KEEPALIVE=false).');
      return;
    }

    const hours = Number(this.config.get<string>('DB_KEEPALIVE_INTERVAL_HOURS'));
    const intervalHours = Number.isFinite(hours) && hours >= 0.1 ? hours : DEFAULT_INTERVAL_HOURS;
    const intervalMs = Math.round(intervalHours * 3_600_000);

    // Ping once now (the app just booted), then on a fixed schedule.
    void this.ping();
    this.timer = setInterval(() => void this.ping(), intervalMs);
    this.timer.unref(); // never keeps the process alive on its own
    this.logger.log(`Database keep-alive ON - pinging every ${intervalHours} hour(s).`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One lightweight round trip. Never throws: a failed ping is logged and the next one retries. */
  async ping(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT now()');
      this.logger.log('Pinged the database - connection is alive.');
      return true;
    } catch (err) {
      this.logger.warn(`Database ping failed: ${(err as Error).message}`);
      return false;
    }
  }
}
