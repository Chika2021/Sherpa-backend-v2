import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThanOrEqual, QueryFailedError, Repository } from 'typeorm';
import * as bcrypt from 'bcryptjs';
import {
  Application,
  GeneratedDocument,
  InterviewPrep,
  Job,
  LiveInterview,
  PaymentTransaction,
  Resume,
  SkillTutorial,
  SupportTicket,
  TokenBillingLedger,
  User,
  normalizeEmail,
} from '../entities';
import { assertValidId, escapeLike } from '../database/db-utils';
import { TokensService } from '../tokens/tokens.service';
import { GeminiService } from '../ai/gemini.service';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import { manageableRoles } from '../common/roles';
import { CreateUserDto, ListPaymentsQueryDto, ListUsersQueryDto, UpdateUserDto } from './admin.dto';

/** Who is calling: the id and role from the signed-in account. */
export interface Actor {
  id: string;
  role: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const PROFILE_FIELDS = ['firstName', 'lastName', 'phone', 'location', 'linkedinUrl', 'portfolioUrl'] as const;

@Injectable()
export class AdminService {
  constructor(
    private config: ConfigService,
    private tokens: TokensService,
    private gemini: GeminiService,
    private mail: MailService,
    private realtime: RealtimeService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Resume) private resumes: Repository<Resume>,
    @InjectRepository(Job) private jobs: Repository<Job>,
    @InjectRepository(Application) private applications: Repository<Application>,
    @InjectRepository(GeneratedDocument) private documents: Repository<GeneratedDocument>,
    @InjectRepository(InterviewPrep) private interviewPreps: Repository<InterviewPrep>,
    @InjectRepository(LiveInterview) private liveInterviews: Repository<LiveInterview>,
    @InjectRepository(SkillTutorial) private tutorials: Repository<SkillTutorial>,
    @InjectRepository(PaymentTransaction) private payments: Repository<PaymentTransaction>,
    @InjectRepository(TokenBillingLedger) private ledger: Repository<TokenBillingLedger>,
    @InjectRepository(SupportTicket) private tickets: Repository<SupportTicket>,
  ) {}

  /** Cheap: just the headline number. Used by the live stream. */
  async userCounts() {
    const now = Date.now();
    const [total, today, week] = await Promise.all([
      this.users.count(),
      this.users.count({ where: { createdAt: MoreThanOrEqual(new Date(new Date().setHours(0, 0, 0, 0))) } }),
      this.users.count({ where: { createdAt: MoreThanOrEqual(new Date(now - 7 * DAY_MS)) } }),
    ]);
    return { totalUsers: total, newToday: today, newLast7Days: week, at: new Date().toISOString() };
  }

  /** Just the total. This is all the STAFF countdown is allowed to see. */
  async totalUsers() {
    return { totalUsers: await this.users.count(), at: new Date().toISOString() };
  }

  async overview() {
    const now = Date.now();
    const since = (days: number) => MoreThanOrEqual(new Date(now - days * DAY_MS));

    const [
      counts,
      suspended,
      admins,
      new30,
      resumes,
      jobs,
      docs,
      interviewPreps,
      liveInterviews,
      tutorials,
      openTickets,
      totalTickets,
    ] = await Promise.all([
      this.userCounts(),
      this.users.count({ where: { suspended: true } }),
      this.users.count({ where: { role: 'ADMIN' } }),
      this.users.count({ where: { createdAt: since(30) } }),
      this.resumes.count(),
      this.jobs.count(),
      this.documents.count(),
      this.interviewPreps.count(),
      this.liveInterviews.count(),
      this.tutorials.count(),
      this.tickets.count({ where: { awaitingAdmin: true, status: 'OPEN' } }),
      this.tickets.count(),
    ]);

    const [appByStatus, tokenAgg, revenue, activeUsers] = await Promise.all([
      this.applications
        .createQueryBuilder('a')
        .select('a.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('a.status')
        .getRawMany<{ status: string; count: string }>(),
      this.users
        .createQueryBuilder('u')
        .select('COALESCE(SUM(u.tokens), 0)', 'inCirculation')
        .getRawOne<{ inCirculation: string }>(),
      this.payments
        .createQueryBuilder('p')
        .select('COALESCE(SUM(p."amountUsd"), 0)', 'usd')
        .addSelect('COUNT(*)', 'count')
        .where("p.status = 'SUCCESS'")
        .getRawOne<{ usd: string; count: string }>(),
      this.users.count({ where: { lastLoginAt: since(7) } }),
    ]);

    const usage = await this.ledger
      .createQueryBuilder('l')
      .select('COALESCE(SUM(ABS(l.tokens)), 0)', 'spent')
      .where("l.\"entryType\" = 'USAGE'")
      .getRawOne<{ spent: string }>();

    const roleRows = await this.users
      .createQueryBuilder('u')
      .select('u.role', 'role')
      .addSelect('COUNT(*)', 'count')
      .groupBy('u.role')
      .getRawMany<{ role: string; count: string }>();
    const byRole = Object.fromEntries(roleRows.map((r) => [r.role, Number(r.count)]));

    const applicationsByStatus = Object.fromEntries(appByStatus.map((r) => [r.status, Number(r.count)]));

    return {
      users: {
        total: counts.totalUsers,
        newToday: counts.newToday,
        newLast7Days: counts.newLast7Days,
        newLast30Days: new30,
        activeLast7Days: activeUsers,
        suspended,
        admins,
        superAdmins: byRole.SUPER_ADMIN ?? 0,
        management: byRole.MANAGEMENT ?? 0,
        staff: byRole.STAFF ?? 0,
        testers: byRole.TESTER ?? 0,
      },
      content: {
        resumes,
        jobsIndexed: jobs,
        generatedDocuments: docs,
        interviewPreps,
        liveInterviews,
        skillTutorials: tutorials,
        applicationsTotal: Object.values(applicationsByStatus).reduce((a, b) => a + b, 0),
        applicationsByStatus,
      },
      billing: {
        tokensInCirculation: Number(tokenAgg?.inCirculation ?? 0),
        tokensSpentAllTime: Number(usage?.spent ?? 0),
        successfulPayments: Number(revenue?.count ?? 0),
        revenueUsd: Number(Number(revenue?.usd ?? 0).toFixed(2)),
      },
      support: { openTickets, totalTickets },
      generatedAt: new Date().toISOString(),
    };
  }

  /** Sign-ups per day for the last N days, zero-filled so the chart has no gaps. */
  async signups(days = 30) {
    const n = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setTime(start.getTime() - (n - 1) * DAY_MS);

    const rows = await this.users
      .createQueryBuilder('u')
      .select(`to_char(date_trunc('day', u."createdAt"), 'YYYY-MM-DD')`, 'day')
      .addSelect('COUNT(*)', 'count')
      .where('u."createdAt" >= :start', { start })
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; count: string }>();
    const byDay = new Map(rows.map((r) => [r.day, Number(r.count)]));

    const out: Array<{ day: string; count: number }> = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(start.getTime() + i * DAY_MS);
      const key = d.toISOString().slice(0, 10);
      out.push({ day: key, count: byDay.get(key) ?? 0 });
    }
    return out;
  }

  /** Server / configuration facts for the "App info" tab. Booleans only - never secret values. */
  systemInfo() {
    const has = (k: string) => Boolean(this.config.get<string>(k));
    const mem = process.memoryUsage();
    let ai: unknown = null;
    try {
      ai = this.gemini.getAiStatus();
    } catch {
      ai = null;
    }
    return {
      app: { name: 'Sherpar API', nodeEnv: process.env.NODE_ENV ?? 'development', port: process.env.PORT ?? 3000 },
      runtime: {
        node: process.version,
        platform: process.platform,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
      },
      integrations: {
        mailProvider: this.mail.providerName(),
        paystackConfigured: has('PAYSTACK_SECRET_KEY'),
        cerebrasConfigured: has('CEREBRAS_API_KEY'),
        redisHost: this.config.get<string>('REDIS_HOST') || '127.0.0.1',
        databaseSsl: this.config.get<string>('DATABASE_SSL') ?? 'auto',
      },
      pricing: this.tokens.pricing(),
      ai,
    };
  }

  async listUsers(q: ListUsersQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const search = q.search?.trim();

    // Super admin accounts are never listed - they are not managed through the dashboard.
    const qb = this.users.createQueryBuilder('u').where('u.role <> :sa', { sa: 'SUPER_ADMIN' });
    if (search) {
      const like = `%${escapeLike(search)}%`;
      qb.andWhere(
        `(u.email ILIKE :like OR u."firstName" ILIKE :like OR u."lastName" ILIKE :like OR u.phone ILIKE :like)`,
        { like },
      );
    }
    if (q.role) qb.andWhere('u.role = :role', { role: q.role });
    if (q.status === 'suspended') qb.andWhere('u.suspended = true');
    if (q.status === 'active') qb.andWhere('u.suspended = false');

    const sortable: Record<string, string> = {
      createdAt: 'u."createdAt"',
      lastLoginAt: 'u."lastLoginAt"',
      email: 'u.email',
      tokens: 'u.tokens',
    };
    qb.orderBy(sortable[q.sort ?? 'createdAt'] ?? 'u."createdAt"', q.order === 'asc' ? 'ASC' : 'DESC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((u) => this.publicUser(u)),
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
    };
  }

  async getUser(id: string) {
    const user = await this.requireVisible(id);

    const [resumes, applications, documents, tickets, recentLedger] = await Promise.all([
      this.resumes.count({ where: { userId: id } }),
      this.applications.count({ where: { userId: id } }),
      this.documents.count({ where: { userId: id } }),
      this.tickets.count({ where: { userId: id } }),
      this.ledger.find({ where: { userId: id }, order: { createdAt: 'DESC' }, take: 15 }),
    ]);
    return { user: this.publicUser(user), activity: { resumes, applications, documents, tickets }, recentLedger };
  }

  /** Creates an account. SUPER_ADMIN may create any assignable role; MANAGEMENT only user / tester / staff. */
  async createUser(actor: Actor, dto: CreateUserDto) {
    const role = dto.role ?? 'USER';
    this.assertCanAssign(actor, role);
    if (dto.tokens && dto.tokens > 0 && actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only the super admin can give an account starting tokens.');
    }

    const email = normalizeEmail(dto.email);
    if (await this.users.existsBy({ email })) throw new ConflictException('An account with this email already exists');

    let user: User;
    try {
      user = await this.users.save(
        this.users.create({
          email,
          passwordHash: await bcrypt.hash(dto.password, 10),
          firstName: dto.firstName?.trim() || undefined,
          lastName: dto.lastName?.trim() || undefined,
          tokens: 0,
          role,
        }),
      );
    } catch (err) {
      if (err instanceof QueryFailedError && (err as any).driverError?.code === '23505') {
        throw new ConflictException('An account with this email already exists');
      }
      throw err;
    }

    if (dto.tokens && dto.tokens > 0) {
      await this.tokens.credit(user.id, dto.tokens, { entryType: 'ADJUSTMENT', label: 'starting-balance' });
    }

    // Keeps the live counters (dashboard and countdown) in step.
    this.realtime.publish({
      type: 'user.registered',
      user: {
        id: user.id,
        email: user.email,
        name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
        createdAt: user.createdAt,
      },
    });
    return this.publicUser((await this.users.findOneBy({ id: user.id }))!);
  }

  async updateUser(actor: Actor, id: string, dto: UpdateUserDto) {
    if (id === actor.id) throw new ForbiddenException("You can't change your own account here.");
    const user = await this.requireManageable(actor, id);
    if (dto.role) this.assertCanAssign(actor, dto.role);

    const patch: Record<string, unknown> = {};
    if (typeof dto.suspended === 'boolean') patch.suspended = dto.suspended;
    if (dto.role) patch.role = dto.role;
    if (dto.email !== undefined) {
      const email = normalizeEmail(dto.email);
      if (email !== user.email) {
        const clash = await this.users.findOneBy({ email });
        if (clash && clash.id !== user.id) throw new ConflictException('Another account already uses this email');
        patch.email = email;
      }
    }
    if (dto.password) patch.passwordHash = await bcrypt.hash(dto.password, 10);
    for (const key of PROFILE_FIELDS) {
      const value = dto[key];
      if (value !== undefined) patch[key] = value.trim() || null; // empty string clears the field
    }

    if (Object.keys(patch).length) {
      try {
        await this.users.update({ id }, patch as any);
      } catch (err) {
        if (err instanceof QueryFailedError && (err as any).driverError?.code === '23505') {
          throw new ConflictException('Another account already uses this email');
        }
        throw err;
      }
    }
    return this.publicUser((await this.users.findOneBy({ id }))!);
  }

  /**
   * Permanently deletes an account and everything it owns (resumes, applications, documents, saved jobs,
   * token ledger...: those tables cascade). Payment records are KEPT - they are financial history - with
   * the payer's email and name copied onto them first so the Payments screen still says who paid.
   */
  async deleteUser(actor: Actor, id: string) {
    if (id === actor.id) throw new ForbiddenException("You can't delete your own account.");
    const user = await this.requireManageable(actor, id);
    await this.assertPaymentsSurviveDeletion();

    await this.users.manager.transaction(async (em) => {
      await em
        .createQueryBuilder()
        .update(PaymentTransaction)
        .set({ payerEmail: user.email, payerName: [user.firstName, user.lastName].filter(Boolean).join(' ') || null })
        .where('"userId" = :id AND "payerEmail" IS NULL', { id })
        .execute();
      await em.delete(User, { id });
    });

    this.realtime.publish({ type: 'user.deleted', userId: id });
    return { deleted: true, id, email: user.email };
  }

  async grantTokens(actor: Actor, id: string, amount: number, note?: string) {
    await this.requireManageable(actor, id);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) {
      throw new BadRequestException('Amount must be a positive number (max 100,000).');
    }
    return this.tokens.credit(id, amount, {
      entryType: 'ADJUSTMENT',
      label: (note?.trim() || 'admin-grant').slice(0, 120),
    });
  }

  // ---------------------------------------------------------------- payments (SUPER_ADMIN + MANAGEMENT)

  /** How much has been paid into the app. Only SUCCESS payments count as money received. */
  async paymentSummary() {
    const now = Date.now();
    const startOfToday = new Date(new Date().setHours(0, 0, 0, 0));
    const paid = () => this.payments.createQueryBuilder('p').where("p.status = 'SUCCESS'");
    const sumSince = async (from: Date) => {
      const r = await paid().andWhere('p."createdAt" >= :from', { from }).select('COALESCE(SUM(p."amountUsd"), 0)', 'usd').getRawOne<{ usd: string }>();
      return Number(r?.usd ?? 0);
    };

    const [totals, byCurrency, byPurpose, byStatus, today, last7, last30, dailyRows] = await Promise.all([
      paid()
        .select('COALESCE(SUM(p."amountUsd"), 0)', 'usd')
        .addSelect('COUNT(*)', 'count')
        .addSelect('COUNT(DISTINCT p."userId")', 'payers')
        .getRawOne<{ usd: string; count: string; payers: string }>(),
      paid()
        .select('p.currency', 'currency')
        .addSelect('COALESCE(SUM(p.amount), 0)', 'amount')
        .addSelect('COUNT(*)', 'count')
        .groupBy('p.currency')
        .orderBy('SUM(p."amountUsd")', 'DESC')
        .getRawMany<{ currency: string; amount: string; count: string }>(),
      paid()
        .select('p.purpose', 'purpose')
        .addSelect('COALESCE(SUM(p."amountUsd"), 0)', 'usd')
        .addSelect('COUNT(*)', 'count')
        .groupBy('p.purpose')
        .getRawMany<{ purpose: string; usd: string; count: string }>(),
      this.payments
        .createQueryBuilder('p')
        .select('p.status', 'status')
        .addSelect('COUNT(*)', 'count')
        .groupBy('p.status')
        .getRawMany<{ status: string; count: string }>(),
      sumSince(startOfToday),
      sumSince(new Date(now - 7 * DAY_MS)),
      sumSince(new Date(now - 30 * DAY_MS)),
      paid()
        .andWhere('p."createdAt" >= :from', { from: new Date(now - 29 * DAY_MS) })
        .select(`to_char(date_trunc('day', p."createdAt"), 'YYYY-MM-DD')`, 'day')
        .addSelect('COALESCE(SUM(p."amountUsd"), 0)', 'usd')
        .addSelect('COUNT(*)', 'count')
        .groupBy('1')
        .getRawMany<{ day: string; usd: string; count: string }>(),
    ]);

    const dailyMap = new Map(dailyRows.map((r) => [r.day, r]));
    const daily = Array.from({ length: 30 }, (_, i) => {
      const day = new Date(now - (29 - i) * DAY_MS).toISOString().slice(0, 10);
      const r = dailyMap.get(day);
      return { day, usd: round2(Number(r?.usd ?? 0)), count: Number(r?.count ?? 0) };
    });

    return {
      totalUsd: round2(Number(totals?.usd ?? 0)),
      paidCount: Number(totals?.count ?? 0),
      payingUsers: Number(totals?.payers ?? 0),
      todayUsd: round2(today),
      last7DaysUsd: round2(last7),
      last30DaysUsd: round2(last30),
      byCurrency: byCurrency.map((r) => ({ currency: r.currency, amount: round2(Number(r.amount)), count: Number(r.count) })),
      byPurpose: byPurpose.map((r) => ({ purpose: r.purpose, usd: round2(Number(r.usd)), count: Number(r.count) })),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.count)])),
      daily,
    };
  }

  /** Who paid what. Only whitelisted fields are returned - never the raw Paystack payload. */
  async listPayments(q: ListPaymentsQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const search = q.search?.trim();

    const qb = this.payments.createQueryBuilder('p').leftJoinAndSelect('p.user', 'u');
    if (q.status) qb.andWhere('p.status = :status', { status: q.status });
    if (q.purpose) qb.andWhere('p.purpose = :purpose', { purpose: q.purpose });
    if (search) {
      const like = `%${escapeLike(search)}%`;
      qb.andWhere(
        `(p.reference ILIKE :like OR p."payerEmail" ILIKE :like OR p."payerName" ILIKE :like OR u.email ILIKE :like OR u."firstName" ILIKE :like OR u."lastName" ILIKE :like)`,
        { like },
      );
    }
    qb.orderBy('p."createdAt"', 'DESC').skip((page - 1) * limit).take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((p) => {
        const u = p.user;
        const name = u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : p.payerName ?? '';
        return {
          id: p.id,
          reference: p.reference,
          status: p.status,
          purpose: p.purpose,
          amountUsd: round2(p.amountUsd),
          amount: round2(p.amount),
          currency: p.currency,
          tokensRequested: p.tokensRequested,
          tokensAwarded: p.tokensAwarded,
          packageId: p.packageId ?? null,
          createdAt: p.createdAt,
          paidAt: p.status === 'SUCCESS' ? p.paystackData?.paid_at ?? p.updatedAt : null,
          payer: {
            id: p.userId,
            email: u?.email ?? p.payerEmail ?? null,
            name: name || null,
            accountDeleted: !u,
          },
        };
      }),
      total,
      page,
      limit,
      pages: Math.max(Math.ceil(total / limit), 1),
    };
  }

  // ---------------------------------------------------------------- permission helpers

  /** Any account the dashboard may show. Super admins are invisible (404). */
  private async requireVisible(id: string) {
    assertValidId(id, 'User');
    const user = await this.users.findOneBy({ id });
    if (!user || user.role === 'SUPER_ADMIN') throw new NotFoundException('User not found');
    return user;
  }

  /** An account this actor is allowed to change: super admins never, and for MANAGEMENT only user / tester / staff. */
  private async requireManageable(actor: Actor, id: string) {
    const user = await this.requireVisible(id);
    if (!manageableRoles(actor.role).includes(user.role)) {
      throw new ForbiddenException('Only the super admin can change admin and management accounts.');
    }
    return user;
  }

  private assertCanAssign(actor: Actor, role: string) {
    if (!(manageableRoles(actor.role) as readonly string[]).includes(role)) {
      throw new ForbiddenException(
        actor.role === 'MANAGEMENT'
          ? 'Management can only create user, tester and staff accounts.'
          : 'That role cannot be assigned.',
      );
    }
  }

  /**
   * Payment rows used to be removed together with their user (database cascade). The entity no longer
   * declares that foreign key, but a database that hasn't been re-synced still has it - and deleting a
   * user then would silently erase revenue history. Refuse until the schema has been synced.
   */
  private paymentsDetached = false;
  private async assertPaymentsSurviveDeletion() {
    if (this.paymentsDetached) return;
    const rows = await this.users.query(
      `SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'payment_transactions' AND c.contype = 'f' LIMIT 1`,
    );
    if (rows.length) {
      throw new ConflictException(
        'Deleting users is switched off until the database schema is updated, because it would also delete their payment history. Run "npm run db:sync" (or start once with DB_SYNCHRONIZE=true), then try again.',
      );
    }
    this.paymentsDetached = true;
  }

  private publicUser(u: User) {
    const { passwordHash, passwordResetTokenHash, passwordResetExpiresAt, ...safe } = u.toJSON() as any;
    return safe;
  }
}
