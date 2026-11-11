import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import { User, normalizeEmail } from '../entities/user.entity';
import type { Role } from '../common/roles';

/**
 * Makes the first super admin(s) without a manual SQL edit. This is the ONLY way a SUPER_ADMIN comes to
 * exist - every other account (admin, staff, tester, user) is created by a super admin from the dashboard.
 *   SUPER_ADMIN_EMAILS=you@example.com,other@example.com   -> existing accounts with these emails become SUPER_ADMIN
 *   SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD               -> that account is created (as SUPER_ADMIN) if it doesn't exist yet
 * Runs on every start and is idempotent. Remove SUPER_ADMIN_PASSWORD from the environment once the account exists.
 *
 * Migration help: if none of the SUPER_ADMIN_* variables are set, the old ADMIN_EMAILS / ADMIN_EMAIL /
 * ADMIN_PASSWORD are used instead (and a warning is logged), so an existing deployment isn't locked out.
 * Rename them to SUPER_ADMIN_* - the old names will stop working in a later release.
 */
@Injectable()
export class AdminBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AdminBootstrapService.name);

  constructor(
    private config: ConfigService,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  async onApplicationBootstrap() {
    try {
      const get = (k: string) => this.config.get<string>(k) ?? '';
      const hasNew = ['SUPER_ADMIN_EMAILS', 'SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_PASSWORD'].some((k) => get(k));
      const hasLegacy = ['ADMIN_EMAILS', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'].some((k) => get(k));
      const prefix = hasNew || !hasLegacy ? 'SUPER_ADMIN' : 'ADMIN';
      if (!hasNew && hasLegacy) {
        this.logger.warn('Using the legacy ADMIN_EMAILS / ADMIN_EMAIL / ADMIN_PASSWORD variables for the super admin. Rename them to SUPER_ADMIN_*.');
      }

      const emails = get(`${prefix}_EMAILS`)
        .split(',')
        .map((e) => normalizeEmail(e))
        .filter(Boolean);

      const seedEmail = normalizeEmail(get(`${prefix}_EMAIL`));
      const seedPassword = get(`${prefix}_PASSWORD`);
      if (seedEmail && seedPassword) {
        if (seedPassword.length < 8) {
          this.logger.warn(`${prefix}_PASSWORD is shorter than 8 characters - super admin account not created.`);
        } else if (!(await this.users.findOneBy({ email: seedEmail }))) {
          await this.users.save(
            this.users.create({
              email: seedEmail,
              passwordHash: await bcrypt.hash(seedPassword, 10),
              firstName: 'Super',
              lastName: 'Admin',
              tokens: 0,
              role: 'SUPER_ADMIN',
            }),
          );
          this.logger.log(`Created super admin account ${seedEmail}. Remove ${prefix}_PASSWORD from the environment now.`);
        }
        if (!emails.includes(seedEmail)) emails.push(seedEmail);
      }

      if (emails.length) {
        const res = await this.users.update({ email: In(emails), role: Not('SUPER_ADMIN' as Role) }, { role: 'SUPER_ADMIN' });
        if (res.affected) this.logger.log(`Promoted ${res.affected} account(s) to SUPER_ADMIN from ${prefix}_EMAILS.`);
      } else if (!seedEmail) {
        this.logger.warn('No SUPER_ADMIN_EMAILS / SUPER_ADMIN_EMAIL set - nobody can create admin, staff or tester accounts yet.');
      }
    } catch (err) {
      this.logger.error(`Super admin bootstrap failed: ${(err as Error).message}`);
    }
  }
}
