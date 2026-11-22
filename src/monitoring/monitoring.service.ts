import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  AccountFlag,
  FlagEvidence,
  FlagSeverity,
  FlagStatus,
  PaymentTransaction,
  Referral,
  TokenBillingLedger,
  User,
  UserWarning,
} from '../entities';
import { assertValidId, escapeLike } from '../database/db-utils';
import { DISPOSABLE_EMAIL_DOMAINS, emailDomain, fingerprintOf, RequestFingerprint } from '../common/identity.util';
import { manageableRoles } from '../common/roles';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MONITORING, SEVERITY_RANK } from './monitoring.config';
import { ListFlagsQueryDto } from './monitoring.dto';

export interface ReviewActor {
  id: string;
  role: string;
  name: string;
}

interface RaiseInput {
  userId: string | null;
  userEmail: string;
  rule: string;
  severity: FlagSeverity;
  title: string;
  reason: string;
  evidence: FlagEvidence;
}

const iso = (d: Date | string | number = new Date()) => new Date(d).toISOString();
const MAX_ACTIVITY_LINES = 40;

/**
 * Suspicious-activity monitoring.
 *
 * Rules (thresholds in monitoring.config.ts) run on the events that matter - sign-up, failed logins, AI usage, payments,
 * referrals - plus a background sweep for patterns no single request shows. A rule that fires RAISES A FLAG, which:
 *   1. is stored with the reason and the activity behind it (what the admins review),
 *   2. goes to every ADMIN and SUPER_ADMIN as an in-app notification, a live dashboard event, and (MEDIUM and above)
 *      an email that explains why the account was flagged and what the user did,
 *   3. can then be reviewed: warn the user, suspend the account, or dismiss it.
 * Rules never suspend anyone on their own. A person decides.
 */
@Injectable()
export class MonitoringService implements OnModuleInit {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly secret: string;

  // Short-lived counters kept in memory (a single server instance). They only decide WHEN to look closer;
  // the flag itself is built from the database, so a restart loses nothing important.
  private readonly failedLogins = new Map<string, { times: number[]; ips: Set<string> }>();
  private readonly usageBursts = new Map<string, number[]>();

  constructor(
    private config: ConfigService,
    private mail: MailService,
    private realtime: RealtimeService,
    private notifications: NotificationsService,
    @InjectRepository(AccountFlag) private flags: Repository<AccountFlag>,
    @InjectRepository(UserWarning) private warnings: Repository<UserWarning>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Referral) private referrals: Repository<Referral>,
    @InjectRepository(PaymentTransaction) private payments: Repository<PaymentTransaction>,
    @InjectRepository(TokenBillingLedger) private ledger: Repository<TokenBillingLedger>,
  ) {
    this.secret = this.config.get<string>('JWT_SECRET') || 'sherpar-monitoring';
  }

  onModuleInit() {
    const every = MONITORING.sweepEveryMinutes * 60_000;
    setTimeout(() => void this.sweep(), 60_000).unref();
    setInterval(() => void this.sweep(), every).unref();
  }

  /** The comparable (hashed) IP + device of a request, for sign-up and login. */
  fingerprint(req: Parameters<typeof fingerprintOf>[0]): RequestFingerprint {
    return fingerprintOf(req, this.secret);
  }

  // ======================================================================================================
  // Rules
  // ======================================================================================================

  /** Runs every sign-up rule against a brand-new account. Never throws. */
  async onRegistration(user: Pick<User, 'id' | 'email' | 'createdAt'>, fp: RequestFingerprint, canonical: string): Promise<void> {
    try {
      const signedUpAt = iso(user.createdAt ?? new Date());
      const me = { at: signedUpAt, action: `Created the account ${user.email} from network ${fp.maskedIp}` };

      // 1) Same IP, several accounts in a day.
      if (fp.ipHash) {
        const cfg = MONITORING.sameIpSignups;
        const others: Array<{ id: string; email: string; createdAt: Date }> = await this.users.query(
          `SELECT id, email, "createdAt" FROM users
            WHERE "signupIpHash" = $1 AND id <> $2 AND "createdAt" > now() - ($3 || ' hours')::interval
            ORDER BY "createdAt" ASC LIMIT 25`,
          [fp.ipHash, user.id, String(cfg.windowHours)],
        );
        if (others.length + 1 >= cfg.threshold) {
          const total = others.length + 1;
          await this.raise({
            userId: user.id,
            userEmail: user.email,
            rule: 'SAME_IP_SIGNUPS',
            severity: total >= cfg.highAt ? 'HIGH' : 'MEDIUM',
            title: `${total} accounts created from the same network in ${cfg.windowHours}h`,
            reason:
              `This account is the ${ordinal(total)} one created from the same network address (${fp.maskedIp}) within ${cfg.windowHours} hours. ` +
              `That can be one person farming free sign-up tokens, or a shared network (office, school, mobile carrier), so please check the accounts before acting.`,
            evidence: {
              summary: `${total} sign-ups from ${fp.maskedIp} within ${cfg.windowHours} hours.`,
              activity: [...others.map((o) => ({ at: iso(o.createdAt), action: `Account ${o.email} was created from the same network` })), me],
              related: others.map((o) => ({ userId: o.id, email: o.email, note: 'same network' })),
              data: { network: fp.maskedIp, accountsInWindow: total, threshold: cfg.threshold },
            },
          });
        }
      }

      // 2) Same device, several accounts (ever).
      if (fp.deviceHash) {
        const cfg = MONITORING.sameDeviceAccounts;
        const others: Array<{ id: string; email: string; createdAt: Date }> = await this.users.query(
          `SELECT id, email, "createdAt" FROM users
            WHERE ("signupDeviceHash" = $1 OR "lastDeviceHash" = $1) AND id <> $2
            ORDER BY "createdAt" ASC LIMIT 25`,
          [fp.deviceHash, user.id],
        );
        if (others.length >= cfg.threshold) {
          const total = others.length + 1;
          await this.raise({
            userId: user.id,
            userEmail: user.email,
            rule: 'SAME_DEVICE_ACCOUNTS',
            severity: others.length >= cfg.highAt ? 'HIGH' : 'MEDIUM',
            title: `${total} accounts on the same browser/device`,
            reason:
              `This account was created on a browser that has already been used for ${others.length} other account${others.length === 1 ? '' : 's'}. ` +
              `Creating many accounts on one device is the usual way to collect the free sign-up tokens repeatedly.`,
            evidence: {
              summary: `${total} accounts share one browser/device.`,
              activity: [...others.map((o) => ({ at: iso(o.createdAt), action: `Account ${o.email} used the same device` })), me],
              related: others.map((o) => ({ userId: o.id, email: o.email, note: 'same device' })),
              data: { accountsOnDevice: total, threshold: cfg.threshold + 1 },
            },
          });
        }
      }

      // 3) An alias of a mailbox that already has an account (john+2@gmail.com, j.ohn@gmail.com).
      if (canonical) {
        const twins: Array<{ id: string; email: string; createdAt: Date }> = await this.users.query(
          `SELECT id, email, "createdAt" FROM users WHERE "emailCanonical" = $1 AND id <> $2 ORDER BY "createdAt" ASC LIMIT 10`,
          [canonical, user.id],
        );
        if (twins.length) {
          await this.raise({
            userId: user.id,
            userEmail: user.email,
            rule: 'DUPLICATE_MAILBOX',
            severity: 'MEDIUM',
            title: 'Signed up with an alias of an existing email address',
            reason:
              `${user.email} delivers to the same mailbox as ${twins.map((t) => t.email).join(', ')}. ` +
              `Gmail ignores dots and "+" tags, so these look like different addresses but are one inbox: a common way to get the free tokens more than once.`,
            evidence: {
              summary: `Same mailbox as ${twins.length} existing account${twins.length === 1 ? '' : 's'}.`,
              activity: [...twins.map((t) => ({ at: iso(t.createdAt), action: `Account ${t.email} was created` })), me],
              related: twins.map((t) => ({ userId: t.id, email: t.email, note: 'same mailbox' })),
            },
          });
        }
      }

      // 4) Throwaway mailbox domain.
      const domain = emailDomain(user.email);
      if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
        await this.raise({
          userId: user.id,
          userEmail: user.email,
          rule: 'DISPOSABLE_EMAIL',
          severity: 'LOW',
          title: `Signed up with a throwaway email domain (${domain})`,
          reason: `${domain} is a temporary-mailbox service. People use these to create accounts they do not intend to keep.`,
          evidence: { summary: `Registered with ${user.email}.`, activity: [me], data: { domain } },
        });
      }
    } catch (err) {
      this.logger.warn(`Sign-up rules failed for ${user.id}: ${(err as Error).message}`);
    }
  }

  /** A wrong password for an existing account. Raises a flag after a burst of them. Never throws. */
  noteFailedLogin(user: Pick<User, 'id' | 'email'>, maskedIp: string): void {
    try {
      const cfg = MONITORING.failedLogins;
      const now = Date.now();
      const entry = this.failedLogins.get(user.id) ?? { times: [], ips: new Set<string>() };
      entry.times = entry.times.filter((t) => now - t < cfg.windowMinutes * 60_000);
      entry.times.push(now);
      entry.ips.add(maskedIp);
      this.failedLogins.set(user.id, entry);

      if (entry.times.length >= cfg.threshold) {
        const attempts = entry.times.length;
        const ips = [...entry.ips];
        const first = entry.times[0];
        this.failedLogins.delete(user.id);
        void this.raise({
          userId: user.id,
          userEmail: user.email,
          rule: 'LOGIN_BRUTE_FORCE',
          severity: 'MEDIUM',
          title: `${attempts} wrong-password attempts in ${cfg.windowMinutes} minutes`,
          reason:
            `Someone tried to sign in to ${user.email} with the wrong password ${attempts} times in ${cfg.windowMinutes} minutes ` +
            `(${ips.length} network${ips.length === 1 ? '' : 's'}). The account owner may be forgetting their password, or somebody may be trying to break in.`,
          evidence: {
            summary: `${attempts} failed sign-ins for ${user.email}.`,
            activity: [
              { at: iso(first), action: 'First failed sign-in in this burst' },
              { at: iso(now), action: `${attempts}th failed sign-in` },
            ],
            data: { attempts, networks: ips.join(', '), windowMinutes: cfg.windowMinutes },
          },
        });
      }
    } catch {
      // monitoring must never break a login
    }
  }

  /** A successful sign-in clears the failed-attempt counter and keeps the "latest device" up to date. */
  noteLoginSuccess(userId: string): void {
    this.failedLogins.delete(userId);
  }

  /** Called for every AI generation the user pays for. Cheap: only counts in memory until a burst is detected. */
  noteUsage(userId: string): void {
    try {
      const cfg = MONITORING.rapidUsage;
      const now = Date.now();
      const times = (this.usageBursts.get(userId) ?? []).filter((t) => now - t < cfg.windowMinutes * 60_000);
      times.push(now);
      this.usageBursts.set(userId, times);
      if (times.length >= cfg.threshold) {
        this.usageBursts.delete(userId);
        void this.raiseRapidUsage(userId, times.length);
      }
    } catch {
      // ignore
    }
  }

  private async raiseRapidUsage(userId: string, count: number) {
    try {
      const cfg = MONITORING.rapidUsage;
      const user = await this.users.findOne({ where: { id: userId }, select: { id: true, email: true, role: true } });
      if (!user || user.role !== 'USER') return;
      const rows: Array<{ label: string | null; n: string; last: Date }> = await this.ledger.query(
        `SELECT label, COUNT(*) n, MAX("createdAt") last FROM token_billing_ledger
          WHERE "userId" = $1 AND "entryType" = 'USAGE' AND "createdAt" > now() - ($2 || ' minutes')::interval
          GROUP BY label ORDER BY n DESC LIMIT 8`,
        [userId, String(cfg.windowMinutes)],
      );
      await this.raise({
        userId,
        userEmail: user.email,
        rule: 'RAPID_USAGE',
        severity: 'MEDIUM',
        title: `${count} AI generations in ${cfg.windowMinutes} minutes`,
        reason:
          `This account spent ${count} tokens on AI generations in ${cfg.windowMinutes} minutes. A person normally cannot work that fast, ` +
          `so it may be a script or a shared login. It may also be a heavy legitimate session.`,
        evidence: {
          summary: `${count} generations within ${cfg.windowMinutes} minutes.`,
          activity: rows.map((r) => ({ at: iso(r.last), action: `${r.n} × ${r.label ?? 'AI generation'}` })),
          data: { generations: count, windowMinutes: cfg.windowMinutes },
        },
      });
    } catch (err) {
      this.logger.warn(`Rapid-usage check failed for ${userId}: ${(err as Error).message}`);
    }
  }

  /** A payment that failed verification. Repeated failures look like card testing. Never throws. */
  async onPaymentFailed(userId: string, reference: string): Promise<void> {
    try {
      const cfg = MONITORING.failedPayments;
      const since = new Date(Date.now() - cfg.windowMinutes * 60_000);
      const recent = await this.payments
        .createQueryBuilder('p')
        .where('p."userId" = :userId AND p.status = :status AND p."updatedAt" >= :since', { userId, status: 'FAILED', since })
        .orderBy('p."updatedAt"', 'ASC')
        .take(20)
        .getMany();
      if (recent.length < cfg.threshold) return;
      const user = await this.users.findOne({ where: { id: userId }, select: { id: true, email: true } });
      if (!user) return;
      await this.raise({
        userId,
        userEmail: user.email,
        rule: 'REPEATED_PAYMENT_FAILURES',
        severity: 'MEDIUM',
        title: `${recent.length} failed payments in ${cfg.windowMinutes} minutes`,
        reason:
          `${user.email} had ${recent.length} payment attempts fail within ${cfg.windowMinutes} minutes. ` +
          `Several failures in a row is how stolen cards are tested, but it can also be a customer whose card keeps being declined.`,
        evidence: {
          summary: `${recent.length} failed payments, latest ${reference}.`,
          activity: recent.map((p) => ({ at: iso(p.updatedAt), action: `Payment ${p.reference} for ${p.currency} ${Number(p.amount).toFixed(2)} failed` })),
          data: { failures: recent.length, windowMinutes: cfg.windowMinutes },
        },
      });
    } catch (err) {
      this.logger.warn(`Failed-payment check failed for ${userId}: ${(err as Error).message}`);
    }
  }

  /** Paystack confirmed a different amount/currency than we asked for. That should never happen: it means tampering or a bug. */
  async onPaymentMismatch(userId: string, reference: string, expected: string, got: string): Promise<void> {
    try {
      const user = await this.users.findOne({ where: { id: userId }, select: { id: true, email: true } });
      if (!user) return;
      await this.raise({
        userId,
        userEmail: user.email,
        rule: 'PAYMENT_AMOUNT_MISMATCH',
        severity: 'HIGH',
        title: 'Payment amount did not match what was requested',
        reason:
          `Payment ${reference} was confirmed by Paystack for ${got}, but ${expected} was requested. No tokens were awarded. ` +
          `This happens when a checkout is tampered with, or when Paystack is configured with a different currency than the app.`,
        evidence: {
          summary: `Expected ${expected}, Paystack reported ${got}.`,
          activity: [{ at: iso(), action: `Payment ${reference} failed verification` }],
          data: { reference, expected, got },
        },
      });
    } catch (err) {
      this.logger.warn(`Payment-mismatch flag failed for ${userId}: ${(err as Error).message}`);
    }
  }

  /** A referral was blocked or accepted with a warning sign. `kind` decides the wording. Never throws. */
  async onSuspiciousReferral(input: {
    referee: Pick<User, 'id' | 'email'>;
    referrer: Pick<User, 'id' | 'email'>;
    kind: 'EMAIL' | 'DEVICE' | 'IP';
    blocked: boolean;
    maskedIp?: string;
  }): Promise<void> {
    try {
      const { referee, referrer, kind, blocked } = input;
      const what = { EMAIL: 'the same mailbox', DEVICE: 'the same browser/device', IP: `the same network (${input.maskedIp ?? 'unknown'})` }[kind];
      await this.raise({
        userId: referee.id,
        userEmail: referee.email,
        rule: kind === 'IP' ? 'REFERRAL_SAME_IP' : 'SELF_REFERRAL',
        severity: kind === 'IP' ? 'MEDIUM' : 'HIGH',
        title: kind === 'IP' ? 'Referral from the same network as the referrer' : 'Signed up through their own referral link',
        reason:
          `${referee.email} signed up using ${referrer.email}'s referral link from ${what}. ` +
          (blocked
            ? 'The referral was rejected, so no referral tokens were paid to either account.'
            : 'The referral was accepted (shared networks are common) but nothing is paid to the referrer until the friend verifies their email, and the reward is capped. Please check whether these are two different people.'),
        evidence: {
          summary: `${referee.email} used ${referrer.email}'s link from ${what}.`,
          activity: [{ at: iso(), action: `${referee.email} registered with ${referrer.email}'s referral code` }],
          related: [{ userId: referrer.id, email: referrer.email, note: 'referrer' }],
          data: { blocked, match: kind },
        },
      });
    } catch (err) {
      this.logger.warn(`Referral flag failed for ${input.referee.id}: ${(err as Error).message}`);
    }
  }

  /** A referrer just got another friend. Checks how fast they are bringing people in. Never throws. */
  async onReferralJoined(referrerId: string): Promise<void> {
    try {
      const cfg = MONITORING.referralVelocity;
      const now = Date.now();
      const rows = await this.referrals.find({
        where: { referrerId },
        order: { createdAt: 'DESC' },
        take: 40,
        relations: { referred: true },
      });
      const lastHour = rows.filter((r) => now - r.createdAt.getTime() < 3_600_000);
      const lastDay = rows.filter((r) => now - r.createdAt.getTime() < 86_400_000);
      const hit = lastHour.length >= cfg.hourlyThreshold ? 'hour' : lastDay.length >= cfg.dailyThreshold ? 'day' : null;
      if (!hit) return;
      const referrer = await this.users.findOne({ where: { id: referrerId }, select: { id: true, email: true } });
      if (!referrer) return;
      const group = hit === 'hour' ? lastHour : lastDay;
      await this.raise({
        userId: referrerId,
        userEmail: referrer.email,
        rule: 'REFERRAL_VELOCITY',
        severity: hit === 'hour' ? 'HIGH' : 'MEDIUM',
        title: `${group.length} referred sign-ups in the last ${hit}`,
        reason:
          `${referrer.email} brought in ${group.length} new accounts through their referral link in the last ${hit}. ` +
          `Referral rewards are paid only after each friend verifies their email and are capped, but this speed can mean made-up accounts.`,
        evidence: {
          summary: `${group.length} referral sign-ups within an ${hit}.`,
          activity: group
            .slice()
            .reverse()
            .map((r) => ({ at: iso(r.createdAt), action: `${r.referred?.email ?? 'A friend'} signed up (${r.status.toLowerCase()})` })),
          related: group.map((r) => ({ userId: r.referredUserId, email: r.referred?.email ?? 'unknown' })),
          data: { signupsInWindow: group.length },
        },
      });
    } catch (err) {
      this.logger.warn(`Referral-velocity check failed for ${referrerId}: ${(err as Error).message}`);
    }
  }

  /** Background sweep: patterns that no single request shows. */
  async sweep(): Promise<void> {
    try {
      const cfg = MONITORING.referralRing;
      const rows: Array<{ referrerId: string; hash: string; kind: 'ip' | 'device'; friends: number; ids: string[] }> = await this.referrals.query(
        `SELECT r."referrerId" AS "referrerId", u."signupIpHash" AS hash, 'ip' AS kind, COUNT(*)::int AS friends, array_agg(u.id::text) AS ids
           FROM referrals r JOIN users u ON u.id = r."referredUserId"
          WHERE r."createdAt" > now() - ($1 || ' hours')::interval AND r.status <> 'REJECTED' AND u."signupIpHash" IS NOT NULL
          GROUP BY r."referrerId", u."signupIpHash" HAVING COUNT(*) >= $2
         UNION ALL
         SELECT r."referrerId", u."signupDeviceHash", 'device', COUNT(*)::int, array_agg(u.id::text)
           FROM referrals r JOIN users u ON u.id = r."referredUserId"
          WHERE r."createdAt" > now() - ($1 || ' hours')::interval AND r.status <> 'REJECTED' AND u."signupDeviceHash" IS NOT NULL
          GROUP BY r."referrerId", u."signupDeviceHash" HAVING COUNT(*) >= $3`,
        [String(cfg.windowHours), cfg.sameIpFriends, cfg.sameDeviceFriends],
      );
      for (const row of rows) {
        const [referrer, friends] = await Promise.all([
          this.users.findOne({ where: { id: row.referrerId }, select: { id: true, email: true } }),
          this.users.find({ where: { id: In(row.ids) }, select: { id: true, email: true, createdAt: true } }),
        ]);
        if (!referrer) continue;
        const device = row.kind === 'device';
        await this.raise({
          userId: referrer.id,
          userEmail: referrer.email,
          rule: device ? 'REFERRAL_RING_DEVICE' : 'REFERRAL_RING_IP',
          severity: device ? 'HIGH' : 'MEDIUM',
          title: `${row.friends} referred friends share one ${device ? 'device' : 'network'}`,
          reason:
            `${row.friends} of the accounts that signed up through ${referrer.email}'s link in the last ${cfg.windowHours} hours were created from the same ${device ? 'browser/device' : 'network address'}. ` +
            `Real friends rarely sign up from one ${device ? 'device' : 'connection'}; this is how one person farms referral rewards with several accounts.`,
          evidence: {
            summary: `${row.friends} referred accounts from one ${device ? 'device' : 'network'}.`,
            activity: friends
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
              .map((f) => ({ at: iso(f.createdAt), action: `${f.email} signed up through the referral link` })),
            related: friends.map((f) => ({ userId: f.id, email: f.email, note: device ? 'same device' : 'same network' })),
            data: { friends: row.friends, match: row.kind },
          },
        });
      }
    } catch (err) {
      this.logger.warn(`Monitoring sweep failed: ${(err as Error).message}`);
    }
  }

  // ======================================================================================================
  // Raising a flag
  // ======================================================================================================

  /**
   * Creates a flag, or - if the same rule already has an OPEN flag on this account - adds to it instead of piling
   * up duplicates. Admins are alerted on creation and when a repeat makes it more severe. Never throws.
   */
  async raise(input: RaiseInput): Promise<AccountFlag | null> {
    try {
      const existing = input.userId
        ? await this.flags.findOne({ where: { userId: input.userId, rule: input.rule, status: In(['OPEN']) } })
        : null;

      if (existing) {
        const escalated = SEVERITY_RANK[input.severity] > SEVERITY_RANK[existing.severity];
        existing.occurrences += 1;
        existing.lastSeenAt = new Date();
        existing.evidence = mergeEvidence(existing.evidence, input.evidence);
        if (escalated) {
          existing.severity = input.severity;
          existing.severityRank = SEVERITY_RANK[input.severity];
          existing.title = input.title;
          existing.reason = input.reason;
        }
        const saved = await this.flags.save(existing);
        if (escalated) await this.alertAdmins(saved, true);
        return saved;
      }

      const flag = await this.flags.save(
        this.flags.create({
          userId: input.userId,
          userEmail: input.userEmail,
          rule: input.rule,
          severity: input.severity,
          severityRank: SEVERITY_RANK[input.severity],
          status: 'OPEN',
          title: input.title.slice(0, 200),
          reason: input.reason,
          evidence: { ...input.evidence, activity: input.evidence.activity.slice(-MAX_ACTIVITY_LINES) },
          occurrences: 1,
          lastSeenAt: new Date(),
        }),
      );
      await this.alertAdmins(flag, false);
      return flag;
    } catch (err) {
      this.logger.error(`Could not raise flag ${input.rule} for ${input.userEmail}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * The feedback to the admins: WHY the account was flagged and WHAT it did. Three channels - the bell, the live
   * dashboard stream, and an email for MEDIUM and above. Never throws.
   */
  private async alertAdmins(flag: AccountFlag, escalated: boolean): Promise<void> {
    try {
      const admins = await this.users.find({
        where: { role: In(['ADMIN', 'SUPER_ADMIN']), suspended: false },
        select: { id: true, email: true, role: true, firstName: true },
      });

      const headline = `${escalated ? 'Escalated' : 'Flagged'}: ${flag.userEmail}`;
      const body = `${flag.title}. ${flag.reason}`;
      await Promise.all(
        admins.map((a) =>
          this.notifications.notify(a.id, {
            type: 'FLAG',
            title: headline,
            body,
            link: `${a.role === 'SUPER_ADMIN' ? '/dashboard/super-admin' : '/dashboard/admin'}?tab=flags&flag=${flag.id}`,
            meta: { flagId: flag.id, severity: flag.severity, rule: flag.rule },
          }),
        ),
      );

      this.realtime.publish({
        type: 'flag.new',
        flag: { id: flag.id, userEmail: flag.userEmail, severity: flag.severity, title: flag.title, rule: flag.rule },
      });

      if (SEVERITY_RANK[flag.severity] >= SEVERITY_RANK[MONITORING.emailFromSeverity]) {
        const app = (this.config.get<string>('FRONTEND_URL') || this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
        const review = (path: string) => (app ? `${app}${path}?tab=flags&flag=${flag.id}` : '(open the Flagged accounts tab in the dashboard)');
        const recipients = new Set<string>(admins.map((a) => a.email));
        for (const key of ['SUPER_ADMIN_EMAILS', 'ADMIN_EMAILS', 'SUPER_ADMIN_EMAIL', 'ADMIN_EMAIL', 'SECURITY_ALERT_EMAILS']) {
          for (const e of (this.config.get<string>(key) ?? '').split(',')) if (e.trim()) recipients.add(e.trim().toLowerCase());
        }
        const text = this.describeForEmail(flag, review('/dashboard/admin'));
        const subject = `[${flag.severity}] ${escalated ? 'Escalated: ' : ''}Account flagged: ${flag.userEmail}`;
        await Promise.all([...recipients].map((to) => this.mail.sendNotification(to, subject, text)));
      }
    } catch (err) {
      this.logger.warn(`Could not alert the admins about flag ${flag.id}: ${(err as Error).message}`);
    }
  }

  private describeForEmail(flag: AccountFlag, reviewUrl: string): string {
    const lines = [
      `Severity: ${flag.severity}`,
      `Account: ${flag.userEmail}`,
      `Rule: ${flag.rule}${flag.occurrences > 1 ? ` (seen ${flag.occurrences} times)` : ''}`,
      '',
      `WHY IT WAS FLAGGED`,
      flag.reason,
      '',
      `WHAT THE ACCOUNT DID`,
      ...(flag.evidence.activity.length
        ? flag.evidence.activity.slice(-12).map((a) => `- ${a.at.replace('T', ' ').slice(0, 16)} UTC: ${a.action}`)
        : ['- (no activity details)']),
    ];
    const related = flag.evidence.related ?? [];
    if (related.length) {
      lines.push('', 'OTHER ACCOUNTS INVOLVED', ...related.slice(0, 8).map((r) => `- ${r.email}${r.note ? ` (${r.note})` : ''}`));
    }
    lines.push(
      '',
      `Review it here and choose to warn the user, suspend the account, or dismiss the flag:`,
      reviewUrl,
      '',
      'Nothing has been done to the account automatically.',
    );
    return lines.join('\n');
  }

  // ======================================================================================================
  // Review (ADMIN and SUPER_ADMIN)
  // ======================================================================================================

  async summary() {
    const [byStatus, openBySeverity, byRule, last24h] = await Promise.all([
      this.flags.createQueryBuilder('f').select('f.status', 'status').addSelect('COUNT(*)', 'n').groupBy('f.status').getRawMany<{ status: string; n: string }>(),
      this.flags
        .createQueryBuilder('f')
        .select('f.severity', 'severity')
        .addSelect('COUNT(*)', 'n')
        .where("f.status = 'OPEN'")
        .groupBy('f.severity')
        .getRawMany<{ severity: string; n: string }>(),
      this.flags
        .createQueryBuilder('f')
        .select('f.rule', 'rule')
        .addSelect('COUNT(*)', 'n')
        .where("f.status = 'OPEN'")
        .groupBy('f.rule')
        .orderBy('n', 'DESC')
        .limit(8)
        .getRawMany<{ rule: string; n: string }>(),
      this.flags.createQueryBuilder('f').where('f."createdAt" > :since', { since: new Date(Date.now() - 86_400_000) }).getCount(),
    ]);
    const status = Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)]));
    const sev = Object.fromEntries(openBySeverity.map((r) => [r.severity, Number(r.n)]));
    return {
      open: status.OPEN ?? 0,
      openHigh: sev.HIGH ?? 0,
      openMedium: sev.MEDIUM ?? 0,
      openLow: sev.LOW ?? 0,
      warned: status.WARNED ?? 0,
      suspended: status.SUSPENDED ?? 0,
      dismissed: status.DISMISSED ?? 0,
      resolved: status.RESOLVED ?? 0,
      newLast24h: last24h,
      topOpenRules: byRule.map((r) => ({ rule: r.rule, count: Number(r.n) })),
    };
  }

  async list(q: ListFlagsQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const qb = this.flags.createQueryBuilder('f');
    const status = q.status ?? 'OPEN';
    if (status !== 'ALL') qb.andWhere('f.status = :status', { status });
    if (q.severity) qb.andWhere('f.severity = :severity', { severity: q.severity });
    const search = q.search?.trim();
    if (search) {
      const like = `%${escapeLike(search)}%`;
      qb.andWhere('(f."userEmail" ILIKE :like OR f.title ILIKE :like OR f.rule ILIKE :like)', { like });
    }
    qb.orderBy('f.severityRank', 'DESC').addOrderBy('f.lastSeenAt', 'DESC').skip((page - 1) * limit).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return {
      // The list view leaves the (large) evidence out; GET /admin/flags/:id returns everything.
      items: rows.map(({ evidence, ...rest }) => ({ ...(rest as any), summary: evidence?.summary ?? '' })),
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
    };
  }

  /** Everything an admin needs to decide: the flag, the user, their warnings, other flags, referral links and recent token activity. */
  async get(id: string) {
    assertValidId(id, 'Flag');
    const flag = await this.flags.findOneBy({ id });
    if (!flag) throw new NotFoundException('Flag not found');

    let user: Record<string, any> | null = null;
    let warnings: UserWarning[] = [];
    let otherFlags: Array<Record<string, any>> = [];
    let referral: Record<string, any> = {};
    let recentLedger: TokenBillingLedger[] = [];

    if (flag.userId) {
      const u = await this.users.findOneBy({ id: flag.userId });
      if (u) {
        user = {
          id: u.id,
          email: u.email,
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
          role: u.role,
          suspended: u.suspended,
          suspendedReason: u.suspendedReason ?? null,
          tokens: Number(u.tokens),
          emailVerified: !!u.emailVerifiedAt,
          createdAt: u.createdAt,
          lastLoginAt: u.lastLoginAt ?? null,
        };
        const [w, others, asReferred, madeCount, ledger] = await Promise.all([
          this.warnings.find({ where: { userId: u.id }, order: { createdAt: 'DESC' }, take: 20 }),
          this.flags.find({ where: { userId: u.id }, order: { createdAt: 'DESC' }, take: 11 }),
          this.referrals.findOne({ where: { referredUserId: u.id }, relations: { referrer: true } }),
          this.referrals.count({ where: { referrerId: u.id } }),
          this.ledger.find({ where: { userId: u.id }, order: { createdAt: 'DESC' }, take: 15 }),
        ]);
        warnings = w;
        otherFlags = others
          .filter((f) => f.id !== flag.id)
          .map((f) => ({ id: f.id, rule: f.rule, severity: f.severity, status: f.status, title: f.title, createdAt: f.createdAt }));
        referral = {
          referredBy: asReferred
            ? { referralId: asReferred.id, referrerId: asReferred.referrerId, referrerEmail: asReferred.referrer?.email ?? null, status: asReferred.status, rejectedReason: asReferred.rejectedReason ?? null }
            : null,
          friendsReferred: madeCount,
        };
        recentLedger = ledger;
      }
    }
    return { flag, user, warnings, otherFlags, referral, recentLedger };
  }

  /** Open-flag counts for a page of users (the Users list shows a "flagged" badge). */
  async openFlagCounts(userIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!userIds.length) return out;
    const rows = await this.flags
      .createQueryBuilder('f')
      .select('f."userId"', 'userId')
      .addSelect('COUNT(*)', 'n')
      .where("f.status = 'OPEN' AND f.\"userId\" IN (:...ids)", { ids: userIds })
      .groupBy('f."userId"')
      .getRawMany<{ userId: string; n: string }>();
    for (const r of rows) out.set(r.userId, Number(r.n));
    return out;
  }

  /** Sends the user a warning (notification + email) and records it. */
  async warn(actor: ReviewActor, flagId: string, message: string) {
    const flag = await this.requireReviewable(flagId, ['OPEN', 'WARNED']);
    const user = await this.requireActionableUser(actor, flag);
    const text = message.trim();

    await this.warnings.save(
      this.warnings.create({ userId: user.id, issuedById: actor.id, issuedByName: actor.name, flagId: flag.id, message: text }),
    );
    await this.notifications.notify(user.id, {
      type: 'WARNING',
      title: 'Warning about your account',
      body: text,
      meta: { flagId: flag.id },
    });
    void this.mail.sendNotification(
      user.email,
      'A warning about your Sherpar account',
      `Hi ${user.firstName || 'there'},\n\n${text}\n\nPlease follow our rules for using the app. Repeated violations can lead to your account being suspended.\n\nIf you think this is a mistake, reply from the Helpdesk in the app.\n\n- The Sherpar team`,
    );

    return this.close(flag, actor, 'WARNED', `Warned: ${text}`.slice(0, 500));
  }

  /** Suspends the account (it cannot sign in or use any endpoint). The reason is shown to the user. */
  async suspend(actor: ReviewActor, flagId: string, reason: string) {
    const flag = await this.requireReviewable(flagId, ['OPEN', 'WARNED']);
    const user = await this.requireActionableUser(actor, flag);
    const why = reason.trim();

    await this.users.update({ id: user.id }, { suspended: true, suspendedReason: why });
    void this.mail.sendNotification(
      user.email,
      'Your Sherpar account has been suspended',
      `Hi ${user.firstName || 'there'},\n\nYour account has been suspended.\n\nReason: ${why}\n\nIf you believe this is a mistake, contact support and we will review it.\n\n- The Sherpar team`,
    );

    // Every other open flag on this account is now moot.
    await this.flags
      .createQueryBuilder()
      .update()
      .set({ status: 'SUSPENDED', reviewedById: actor.id, reviewedByName: actor.name, reviewedAt: new Date(), reviewNote: `Account suspended: ${why}`.slice(0, 500) })
      .where('"userId" = :userId AND status = :open AND id <> :id', { userId: user.id, open: 'OPEN', id: flag.id })
      .execute();

    return this.close(flag, actor, 'SUSPENDED', `Suspended: ${why}`.slice(0, 500));
  }

  /** Nothing wrong: close the flag. */
  async dismiss(actor: ReviewActor, flagId: string, note?: string) {
    const flag = await this.requireReviewable(flagId, ['OPEN', 'WARNED']);
    return this.close(flag, actor, 'DISMISSED', note?.trim() || 'Reviewed: no action needed');
  }

  /** Lifts a suspension that came from a flag. */
  async reinstate(actor: ReviewActor, flagId: string, note?: string) {
    const flag = await this.requireReviewable(flagId, ['SUSPENDED']);
    const user = await this.requireActionableUser(actor, flag);
    await this.users.update({ id: user.id }, { suspended: false, suspendedReason: null });
    await this.notifications.notify(user.id, {
      type: 'ACCOUNT',
      title: 'Your account is active again',
      body: 'Your suspension has been lifted. You can use the app normally.',
    });
    void this.mail.sendNotification(
      user.email,
      'Your Sherpar account is active again',
      `Hi ${user.firstName || 'there'},\n\nYour suspension has been lifted and you can sign in again.\n\n- The Sherpar team`,
    );
    return this.close(flag, actor, 'RESOLVED', note?.trim() || 'Suspension lifted');
  }

  // ---- helpers ----

  private async requireReviewable(id: string, allowed: FlagStatus[]): Promise<AccountFlag> {
    assertValidId(id, 'Flag');
    const flag = await this.flags.findOneBy({ id });
    if (!flag) throw new NotFoundException('Flag not found');
    if (!allowed.includes(flag.status)) {
      throw new BadRequestException(`This flag is already ${flag.status.toLowerCase()}.`);
    }
    return flag;
  }

  /** ADMIN may act on normal USER accounts; SUPER_ADMIN on every account except other super admins. Nobody acts on themselves. */
  private async requireActionableUser(actor: ReviewActor, flag: AccountFlag): Promise<User> {
    if (!flag.userId) throw new BadRequestException('The flagged account no longer exists.');
    const user = await this.users.findOneBy({ id: flag.userId });
    if (!user) throw new NotFoundException('The flagged account no longer exists.');
    if (user.id === actor.id) throw new ForbiddenException("You can't take action on your own account.");
    const allowed: readonly string[] = actor.role === 'SUPER_ADMIN' ? manageableRoles('SUPER_ADMIN') : ['USER'];
    if (!allowed.includes(user.role)) {
      throw new ForbiddenException('Only the super admin can act on this kind of account.');
    }
    return user;
  }

  private async close(flag: AccountFlag, actor: ReviewActor, status: FlagStatus, note: string) {
    flag.status = status;
    flag.reviewedById = actor.id;
    flag.reviewedByName = actor.name;
    flag.reviewedAt = new Date();
    flag.reviewNote = note;
    await this.flags.save(flag);
    this.realtime.publish({ type: 'flag.updated', flag: { id: flag.id, status: flag.status } });
    return this.get(flag.id);
  }
}

// ---------------------------------------------------------------------------------------------------------

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** Adds new activity to an existing flag without repeating lines it already has. */
function mergeEvidence(old: FlagEvidence, next: FlagEvidence): FlagEvidence {
  const seen = new Set(old.activity.map((a) => `${a.at}|${a.action}`));
  const activity = [...old.activity, ...next.activity.filter((a) => !seen.has(`${a.at}|${a.action}`))].slice(-MAX_ACTIVITY_LINES);
  const related = [...(old.related ?? [])];
  for (const r of next.related ?? []) {
    if (!related.some((x) => x.email === r.email)) related.push(r);
  }
  return { summary: next.summary, activity, related: related.length ? related : undefined, data: { ...(old.data ?? {}), ...(next.data ?? {}) } };
}

