import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JobSourceSettings } from '../entities/job-source-settings.entity';

export interface JobSourceFlags {
  adzunaEnabled: boolean;
  weAreDevelopersEnabled: boolean;
  arcDevEnabled: boolean;
}

/**
 * Maps a JobSourceProvider's own `name` (see providers/*.provider.ts) to the
 * settings flag that gates it. Providers not listed here (remotive,
 * remoteok, arbeitnow, jobicy, contra) are free, always-on sources and are
 * never gated by this document.
 */
const GATED_PROVIDER_FLAG: Record<string, keyof JobSourceFlags> = {
  adzuna: 'adzunaEnabled',
  wearedevelopers: 'weAreDevelopersEnabled',
  // No arc.dev provider exists in this codebase yet - see the schema's
  // comment. Keyed here already so wiring one up later is just adding the
  // provider, not touching this map.
  arcdev: 'arcDevEnabled',
};

/**
 * Single source of truth for which optional job-board providers are allowed
 * to run. Backed by exactly ONE row in Postgres - this is a global
 * operational switch (every user's search is affected the same way), not a
 * per-user preference - so JobsService.collectRealListings can read it fresh
 * on every search and a toggle here takes effect on the very next request,
 * with no .env edit and no server restart.
 */
@Injectable()
export class JobSourceSettingsService {
  constructor(
    @InjectRepository(JobSourceSettings) private settings: Repository<JobSourceSettings>,
    private config: ConfigService,
  ) {}

  private envDefault(key: string): boolean {
    const raw = this.config.get<string>(key);
    return raw === 'true' || raw === '1';
  }

  private toFlags(doc: JobSourceSettings): JobSourceFlags {
    return {
      adzunaEnabled: doc.adzunaEnabled,
      weAreDevelopersEnabled: doc.weAreDevelopersEnabled,
      arcDevEnabled: doc.arcDevEnabled,
    };
  }

  /**
   * Returns the persisted flags, atomically creating the one-and-only
   * settings document the first time this is ever called. The very first
   * boot seeds from ADZUNA_ENABLED / WEAREDEVELOPERS_ENABLED / ARC_DEV_ENABLED
   * if an ops team set them, so an intended starting state can still be
   * configured via the environment - but every read/write after that goes
   * through this document, never back to process.env. If those env vars are
   * also unset, every source defaults to false (see the schema).
   */
  async getSettings(): Promise<JobSourceFlags> {
    let row = await this.settings.findOne({ where: { singleton: true } });
    if (!row) {
      // `singleton` is UNIQUE, so if two requests race here only one insert wins; the other is a no-op.
      await this.settings
        .createQueryBuilder()
        .insert()
        .values({
          singleton: true,
          adzunaEnabled: this.envDefault('ADZUNA_ENABLED'),
          weAreDevelopersEnabled: this.envDefault('WEAREDEVELOPERS_ENABLED'),
          arcDevEnabled: this.envDefault('ARC_DEV_ENABLED'),
        })
        .orIgnore()
        .execute();
      row = await this.settings.findOneByOrFail({ singleton: true });
    }
    const doc = row;
    return this.toFlags(doc);
  }

  async updateSettings(patch: Partial<JobSourceFlags>): Promise<JobSourceFlags> {
    await this.getSettings(); // ensure the singleton row exists before patching it
    // Only real boolean flags are written (an undefined/unknown key must never become a column update).
    const changes: Partial<JobSourceFlags> = {};
    for (const key of ['adzunaEnabled', 'weAreDevelopersEnabled', 'arcDevEnabled'] as const) {
      if (typeof patch?.[key] === 'boolean') changes[key] = patch[key];
    }
    if (Object.keys(changes).length > 0) {
      await this.settings.update({ singleton: true }, changes);
    }
    const doc = await this.settings.findOneByOrFail({ singleton: true });
    return this.toFlags(doc);
  }

  /** True if `providerName` isn't gated at all, or is gated and its flag is on. */
  isEnabled(providerName: string, flags: JobSourceFlags): boolean {
    const key = GATED_PROVIDER_FLAG[providerName.toLowerCase()];
    return key ? flags[key] : true;
  }
}
