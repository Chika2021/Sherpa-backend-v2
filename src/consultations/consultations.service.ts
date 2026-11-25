import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { DataSource, In, IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { Consultation, ConsultationEnrollment, ConsultationSession, PaymentTransaction } from '../entities';
import { assertValidId, escapeLike } from '../database/db-utils';
import { NotificationsService } from '../notifications/notifications.service';
import { TokensService } from '../tokens/tokens.service';
import { PaymentsService, PurposeOutcome } from '../payments/payments.service';
import { ConsultationSessionDto, CreateConsultationDto, ListConsultationsQueryDto, MAX_SESSIONS_PER_CONSULTATION, UpdateConsultationDto } from './consultations.dto';

/** Live consultations one member may be selling at the same time. */
export const MAX_ACTIVE_CONSULTATIONS_PER_USER = 20;
/** How far ahead a consultation may be scheduled. */
export const MAX_DAYS_AHEAD = 180;
/** A multi-session consultation (seminar, course) must fit inside this many days, from its first start to its last end. */
export const MAX_PROGRAM_SPAN_DAYS = 60;
/** Shortest and longest a single SESSION may run. */
export const MIN_DURATION_MINUTES = 15;
export const MAX_DURATION_MINUTES = 8 * 60;
/**
 * The share of each sale the platform keeps, in whole percent. 0 = the seller gets everything students paid.
 * Change it here if you want to take a cut; it is applied when the seller is paid at the end of the consultation.
 */
export const CONSULTATION_PLATFORM_FEE_PERCENT = 0;

/** A share code is 12 URL-safe characters (72 random bits). Anything else is rejected before touching the database. */
const SHARE_CODE_RE = /^[A-Za-z0-9_-]{8,32}$/;

const SWEEP_EVERY_MS = 5 * 60 * 1000;
const SWEEP_BATCH = 100;

type Viewer = { id: string };

/** A validated session, ready to save. `id` is set when it is an existing session being kept or edited. */
type ParsedSession = { id?: string; title: string | null; startsAt: Date; endsAt: Date; meetLink: string | null };

/**
 * Buy and sell virtual consultations.
 *
 *   - A member creates a consultation made of one or more SESSIONS (a single class, or e.g. a 3-day seminar with a
 *     session per day), a price in USD, and (now or later) a Google Meet link - for the whole consultation and/or per
 *     session. Students pay once and can join every session. Consultation.startsAt/endsAt = first start / last end.
 *   - Other members pay the price through the payment gateway (Paystack) to enrol - never with tokens. The place is
 *     confirmed when the payment is verified (see onPaid). The money is HELD by the platform and the seller is paid
 *     once the consultation has ended; if the seller cancels first, every student is refunded in full through
 *     Paystack.
 *   - The seller's earnings (price minus CONSULTATION_PLATFORM_FEE_PERCENT) are credited to their token wallet at
 *     the current token value, because there is no cash payout to sellers yet.
 *   - Only the owner and enrolled students ever receive `meetLink`. Every public response leaves it out.
 *   - "Live" always means `endsAt > now`: expired consultations disappear at once, and the sweep (on start-up, then
 *     every 5 minutes) pays the seller and deletes the row for good.
 */
@Injectable()
export class ConsultationsService implements OnModuleInit {
  private readonly logger = new Logger(ConsultationsService.name);
  private sweeping = false;

  constructor(
    @InjectRepository(Consultation) private consultations: Repository<Consultation>,
    @InjectRepository(ConsultationEnrollment) private enrollments: Repository<ConsultationEnrollment>,
    @InjectRepository(ConsultationSession) private sessions: Repository<ConsultationSession>,
    @InjectDataSource() private dataSource: DataSource,
    private tokens: TokensService,
    private notifications: NotificationsService,
    private payments: PaymentsService,
    private config: ConfigService,
  ) {}

  onModuleInit() {
    // PaymentsService calls this when a consultation payment is verified, so it never has to import this module.
    this.payments.registerPurposeHandler('CONSULTATION', (tx) => this.onPaid(tx));
    void this.backfillSessions();
    void this.sweepEnded();
    setInterval(() => void this.sweepEnded(), SWEEP_EVERY_MS).unref();
  }

  // ---------------------------------------------------------------- create / read

  async create(userId: string, dto: CreateConsultationDto) {
    assertValidId(userId, 'User');
    const inputs: ConsultationSessionDto[] = dto.sessions?.length
      ? dto.sessions
      : dto.startsAt && dto.endsAt
        ? [{ startsAt: dto.startsAt, endsAt: dto.endsAt } as ConsultationSessionDto]
        : [];
    if (inputs.length === 0) throw new BadRequestException('Add at least one session with a start and end time.');
    const sessions = this.normalizeSessions(inputs, []);

    const active = await this.consultations.count({ where: { ownerId: userId, endsAt: MoreThan(new Date()) } });
    if (active >= MAX_ACTIVE_CONSULTATIONS_PER_USER) {
      throw new BadRequestException(`You can sell up to ${MAX_ACTIVE_CONSULTATIONS_PER_USER} consultations at a time. Delete one or wait for one to end.`);
    }

    const saved = await this.dataSource.transaction(async (em) => {
      const row = await em.save(
        Consultation,
        em.create(Consultation, {
          ownerId: userId,
          title: dto.title,
          description: dto.description,
          category: dto.category ?? 'OTHER',
          priceUsd: roundUsd(dto.priceUsd),
          capacity: dto.capacity ?? null,
          startsAt: sessions[0].startsAt,
          endsAt: sessions[sessions.length - 1].endsAt,
          meetLink: dto.meetLink ?? null,
        }),
      );
      await em.insert(
        ConsultationSession,
        sessions.map((x, i) => ({ consultationId: row.id, position: i, title: x.title, startsAt: x.startsAt, endsAt: x.endsAt, meetLink: x.meetLink })),
      );
      return row;
    });
    return (await this.present([saved], userId))[0];
  }

  /** Everyone's live consultations, soonest first: ?search= &category= &page= &limit= */
  async listPublic(userId: string, q: ListConsultationsQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 7;
    const qb = this.consultations
      .createQueryBuilder('c')
      .leftJoin('c.owner', 'owner')
      .addSelect(['owner.id', 'owner.firstName'])
      .where('c."endsAt" > :now', { now: new Date() })
      .orderBy('c.startsAt', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);
    if (q.category) qb.andWhere('c."category" = :category', { category: q.category });
    const term = q.search?.trim();
    if (term) {
      qb.andWhere('(c.title ILIKE :term OR c.description ILIKE :term)', { term: `%${escapeLike(term)}%` });
    }
    const [rows, total] = await qb.getManyAndCount();
    return { items: await this.present(rows, userId), total, page, limit };
  }

  /** The consultations the signed-in member is selling (with how many enrolled and how much is being held for them). */
  async listMine(userId: string) {
    assertValidId(userId, 'User');
    const rows = await this.consultations.find({
      where: { ownerId: userId, endsAt: MoreThan(new Date()) },
      order: { startsAt: 'ASC' },
    });
    return this.present(rows, userId);
  }

  /** The consultations the signed-in member has paid for (their Meet links are included). */
  async listEnrolled(userId: string) {
    assertValidId(userId, 'User');
    const mine = await this.enrollments.find({ where: { buyerId: userId }, select: { consultationId: true } });
    if (mine.length === 0) return [];
    const rows = await this.consultations
      .createQueryBuilder('c')
      .leftJoin('c.owner', 'owner')
      .addSelect(['owner.id', 'owner.firstName'])
      .where('c.id IN (:...ids)', { ids: mine.map((m) => m.consultationId) })
      .andWhere('c."endsAt" > :now', { now: new Date() })
      .orderBy('c.startsAt', 'ASC')
      .getMany();
    return this.present(rows, userId);
  }

  async getOne(userId: string, id: string) {
    assertValidId(id, 'Consultation');
    const row = await this.consultations.findOne({ where: { id }, relations: { owner: true } });
    if (!row || row.endsAt.getTime() <= Date.now()) throw new NotFoundException('Consultation not found');
    // The student may have paid and closed the tab before Paystack redirected back (and the webhook can be late):
    // settle their still-pending payment now so the place and the Meet link show up.
    if (row.ownerId !== userId) await this.payments.settlePending(userId, 'CONSULTATION', id);
    return (await this.present([row], userId))[0];
  }

  /** Owner only: who has enrolled. */
  async listStudents(userId: string, id: string) {
    await this.ownedLive(userId, id);
    const rows = await this.enrollments.find({ where: { consultationId: id }, relations: { buyer: true }, order: { createdAt: 'ASC' } });
    return rows.map((r) => ({
      id: r.id,
      name: r.buyer?.firstName?.trim() || 'A member',
      paidUsd: r.paymentReference ? r.pricePaidUsd : roundUsd((r.pricePaidTokens ?? 0) * this.tokens.pricing().pricePerTokenUsd),
      enrolledAt: r.createdAt,
    }));
  }

  // ---------------------------------------------------------------- share link

  /**
   * Owner only: returns the consultation's shareable link, creating it the first time. Calling it again returns the same
   * link (it does not rotate). To get a new one, DELETE the link first - that invalidates the old one - then create again.
   */
  async createShareLink(userId: string, id: string) {
    const c = await this.ownedLive(userId, id);
    if (c.shareCode) return this.shareInfo(c.shareCode);

    for (let attempt = 0; attempt < 5; attempt++) {
      const code = crypto.randomBytes(9).toString('base64url'); // 12 chars, URL-safe
      try {
        // Only set it if nobody (e.g. a double click) set one in the meantime.
        const res = await this.consultations.update({ id, ownerId: userId, shareCode: IsNull() }, { shareCode: code });
        if (res.affected) return this.shareInfo(code);
        const fresh = await this.consultations.findOne({ where: { id }, select: { id: true, shareCode: true } });
        if (fresh?.shareCode) return this.shareInfo(fresh.shareCode);
      } catch (err) {
        // Unique-index collision on the code: pick another one.
        if (attempt === 4) throw err;
      }
    }
    throw new BadRequestException('Could not create the link. Please try again.');
  }

  /** Owner only: kills the link. Anyone holding it gets "not found". Students who already enrolled are unaffected. */
  async revokeShareLink(userId: string, id: string) {
    await this.ownedLive(userId, id);
    await this.consultations.update({ id, ownerId: userId }, { shareCode: null });
    return { revoked: true };
  }

  /**
   * Public: what the person opening a shared link sees. `viewerId` is null for someone not signed in (the frontend then
   * asks them to sign in or register before calling enroll). The Meet link stays hidden unless the viewer owns it or paid.
   */
  async getShared(viewerId: string | null, code: string) {
    const c = await this.findByShareCode(code);
    if (viewerId && c.ownerId !== viewerId) await this.payments.settlePending(viewerId, 'CONSULTATION', c.id);
    return (await this.present([c], viewerId))[0];
  }

  /** Signed-in member buys through a shared link: same checks and the same Paystack checkout as POST /consultations/:id/enroll. */
  async enrollViaShare(userId: string, code: string, currency?: string) {
    const c = await this.findByShareCode(code);
    return this.enroll(userId, c.id, currency);
  }

  private async findByShareCode(code: string): Promise<Consultation> {
    if (!SHARE_CODE_RE.test(code ?? '')) throw new NotFoundException('This link is not valid or has been turned off.');
    const c = await this.consultations.findOne({ where: { shareCode: code }, relations: { owner: true } });
    if (!c || c.endsAt.getTime() <= Date.now()) throw new NotFoundException('This link is not valid or has been turned off.');
    return c;
  }

  private shareInfo(code: string) {
    const base = (this.config.get<string>('FRONTEND_URL') || this.config.get<string>('APP_URL') || 'http://localhost:3000').replace(/\/$/, '');
    return { shareCode: code, shareLink: `${base}/consultations/join/${code}` };
  }

  // ---------------------------------------------------------------- buy

  /**
   * Starts the payment for a place. Nothing is taken here: the student gets a Paystack checkout link
   * (`authorizationUrl`) and pays there. The place itself is created by onPaid once the payment is verified, by the
   * webhook or by GET /payments/verify/:reference when Paystack redirects the student back.
   */
  async enroll(userId: string, id: string, currency?: string) {
    assertValidId(userId, 'User');
    assertValidId(id, 'Consultation');
    const c = await this.consultations.findOne({ where: { id } });
    if (!c || c.endsAt.getTime() <= Date.now()) throw new NotFoundException('Consultation not found');
    if (c.ownerId === userId) throw new BadRequestException('You cannot enrol in your own consultation.');
    if (!(c.priceUsd > 0)) throw new BadRequestException('This consultation has no price set yet. Ask the host to set one.');
    if ((await this.enrollments.count({ where: { consultationId: id, buyerId: userId } })) > 0) {
      throw new BadRequestException('You are already enrolled in this consultation.');
    }
    if (c.capacity != null && (await this.enrollments.count({ where: { consultationId: id } })) >= c.capacity) {
      throw new BadRequestException('This consultation is full.');
    }

    const checkout = await this.payments.initializeConsultation(userId, id, c.priceUsd, currency);
    return { ...checkout, consultationId: id, priceUsd: c.priceUsd };
  }

  /**
   * Called by PaymentsService once Paystack has confirmed a consultation payment. Creates the enrolment under a lock
   * (so the last seat cannot be sold twice) and tells the host. Returns 'REFUND' when the place can no longer be
   * given, and PaymentsService then refunds the payment. Safe to call twice for the same payment.
   */
  private async onPaid(tx: PaymentTransaction): Promise<PurposeOutcome> {
    const consultationId = tx.purposeRef;
    if (!consultationId) return 'REFUND';
    let notifyOwner: { ownerId: string; title: string } | null = null;

    const outcome = await this.dataSource.transaction(async (em): Promise<PurposeOutcome> => {
      // This payment already created its enrolment (webhook and verify can both arrive).
      if (await em.count(ConsultationEnrollment, { where: { paymentReference: tx.reference } })) return 'OK';

      const locked = await em.findOne(Consultation, { where: { id: consultationId }, lock: { mode: 'pessimistic_write' } });
      if (!locked || locked.endsAt.getTime() <= Date.now()) return 'REFUND'; // ended or cancelled meanwhile
      if (locked.ownerId === tx.userId) return 'REFUND';
      if ((await em.count(ConsultationEnrollment, { where: { consultationId, buyerId: tx.userId } })) > 0) return 'REFUND'; // paid twice
      if (locked.capacity != null && (await em.count(ConsultationEnrollment, { where: { consultationId } })) >= locked.capacity) return 'REFUND';

      await em.insert(ConsultationEnrollment, {
        consultationId,
        buyerId: tx.userId,
        pricePaidUsd: tx.amountUsd,
        paymentReference: tx.reference,
      });
      notifyOwner = { ownerId: locked.ownerId, title: locked.title };
      return 'OK';
    });

    if (notifyOwner) {
      const n = notifyOwner as { ownerId: string; title: string };
      await this.notifications.notify(n.ownerId, {
        type: 'SYSTEM',
        title: 'New student enrolled',
        body: `Someone enrolled in "${n.title}".`,
        link: '/consultations',
      });
    }
    return outcome;
  }

  // ---------------------------------------------------------------- update / delete (owner only)

  async update(userId: string, id: string, dto: UpdateConsultationDto) {
    const c = await this.ownedLive(userId, id);
    const enrolled = await this.enrollments.count({ where: { consultationId: id } });

    if (dto.priceUsd !== undefined && roundUsd(dto.priceUsd) !== c.priceUsd && enrolled > 0) {
      throw new BadRequestException('The price cannot change after students have enrolled.');
    }
    if (dto.capacity !== undefined && dto.capacity !== null && dto.capacity < enrolled) {
      throw new BadRequestException(`${enrolled} student${enrolled === 1 ? ' has' : 's have'} already enrolled, so the limit cannot be lower than that.`);
    }

    // ---- sessions
    const existing = await this.sessions.find({ where: { consultationId: id }, order: { startsAt: 'ASC' } });
    let incoming = dto.sessions;
    if (!incoming && (dto.startsAt !== undefined || dto.endsAt !== undefined)) {
      // Old-style edit of a one-session consultation.
      if (existing.length !== 1) throw new BadRequestException('This consultation has several sessions. Change them in the session list.');
      const only = existing[0];
      incoming = [{ id: only.id, title: only.title, startsAt: dto.startsAt ?? only.startsAt.toISOString(), endsAt: dto.endsAt ?? only.endsAt.toISOString(), meetLink: only.meetLink } as ConsultationSessionDto];
    }
    let parsed: ParsedSession[] | null = null;
    if (incoming) {
      parsed = this.normalizeSessions(incoming, existing);
      if (enrolled > 0) {
        const kept = new Set(parsed.map((p) => p.id));
        if (existing.some((x) => !kept.has(x.id))) {
          throw new BadRequestException('Students have already enrolled, so sessions cannot be removed. Reschedule them, add more, or cancel the whole consultation.');
        }
      }
    }

    const signature = (list: { startsAt: Date; endsAt: Date }[]) => list.map((x) => `${x.startsAt.getTime()}-${x.endsAt.getTime()}`).join('|');
    const linkSignature = (list: { meetLink?: string | null }[], own: string | null | undefined) => `${own ?? ''}#${list.map((x) => x.meetLink ?? '').join('|')}`;
    const before = { schedule: signature(existing), links: linkSignature(existing, c.meetLink) };

    if (parsed) {
      c.startsAt = parsed[0].startsAt;
      c.endsAt = parsed[parsed.length - 1].endsAt;
    }
    if (dto.title !== undefined) c.title = dto.title;
    if (dto.description !== undefined) c.description = dto.description;
    if (dto.category !== undefined) c.category = dto.category;
    if (dto.priceUsd !== undefined) c.priceUsd = roundUsd(dto.priceUsd);
    if (dto.capacity !== undefined) c.capacity = dto.capacity;
    if (dto.meetLink !== undefined) c.meetLink = dto.meetLink;

    const saved = await this.dataSource.transaction(async (em) => {
      const row = await em.save(Consultation, c);
      if (parsed) {
        const keep = new Set(parsed.map((p) => p.id).filter(Boolean) as string[]);
        const drop = existing.filter((x) => !keep.has(x.id)).map((x) => x.id);
        if (drop.length) await em.delete(ConsultationSession, { id: In(drop) });
        for (const [i, p] of parsed.entries()) {
          const fields = { position: i, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, meetLink: p.meetLink };
          if (p.id) await em.update(ConsultationSession, { id: p.id }, fields);
          else await em.insert(ConsultationSession, { consultationId: id, ...fields });
        }
      }
      return row;
    });

    // Tell the students when the schedule moved or a Meet link was added or changed.
    if (enrolled > 0) {
      const after = parsed ?? existing;
      const scheduleChanged = signature(after) !== before.schedule;
      const linkChanged = linkSignature(after, saved.meetLink) !== before.links && (!!saved.meetLink || after.some((x) => !!x.meetLink));
      if (scheduleChanged || linkChanged) {
        const body = scheduleChanged
          ? after.length > 1
            ? `The schedule of "${saved.title}" changed. Open Consultations to see your ${after.length} sessions.`
            : `"${saved.title}" has a new time: ${after[0].startsAt.toUTCString()}.`
          : `The host added or changed a Google Meet link for "${saved.title}". Open Consultations to join.`;
        await this.notifyStudents(id, { title: scheduleChanged ? 'Consultation schedule changed' : 'Meet link updated', body });
      }
    }
    return (await this.present([saved], userId))[0];
  }

  /** Cancels a consultation before it ends: every student is refunded in full, then it is deleted. */
  async remove(userId: string, id: string) {
    const c = await this.ownedLive(userId, id);
    const students = await this.enrollments.find({ where: { consultationId: id } });

    for (const s of students) {
      // Refund, then remove that enrolment straight away: if one refund fails and the owner retries, the ones already
      // refunded are not refunded twice.
      let refundedText: string;
      if (s.paymentReference) {
        // Paid through the gateway: the money goes back to what they paid with (throws if Paystack refuses, so the cancel stops).
        await this.payments.refundTransaction(s.paymentReference);
        refundedText = `You were refunded $${s.pricePaidUsd.toFixed(2)} to your original payment method.`;
      } else {
        // LEGACY enrolment bought with tokens before consultations moved to the payment gateway.
        const legacyTokens = s.pricePaidTokens ?? 0;
        if (legacyTokens > 0) await this.refund(s.buyerId, legacyTokens, `consultation:refund:${shorten(c.title)}`, s.id, true);
        refundedText = `You were refunded ${legacyTokens} token${legacyTokens === 1 ? '' : 's'}.`;
      }
      await this.enrollments.delete({ id: s.id });
      await this.notifications.notify(s.buyerId, {
        type: 'SYSTEM',
        title: 'Consultation cancelled',
        body: `"${c.title}" was cancelled by the host. ${refundedText}`,
        link: '/consultations',
      });
    }
    await this.consultations.delete({ id, ownerId: userId });
    return { deleted: true, refunded: students.length };
  }

  // ---------------------------------------------------------------- expiry

  /**
   * For every consultation whose end time has passed: pay the seller for each enrolled student, then delete the
   * consultation. If a payment fails the consultation is kept and retried on the next run, so nobody is left unpaid.
   * Never throws: it runs on a timer.
   */
  async sweepEnded(): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let removed = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const ended = await this.consultations.find({ where: { endsAt: LessThanOrEqual(new Date()) }, take: SWEEP_BATCH });
        if (ended.length === 0) break;

        let progress = 0;
        for (const c of ended) {
          if (await this.settleAndDelete(c)) {
            removed++;
            progress++;
          }
        }
        if (ended.length < SWEEP_BATCH || progress === 0) break;
      }
      if (removed > 0) this.logger.log(`Ended and removed ${removed} consultation(s).`);
    } catch (err) {
      this.logger.warn(`Consultation sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
    return removed;
  }

  /** Pays the seller for every unpaid enrolment, then deletes the consultation. Returns false if a payment failed. */
  private async settleAndDelete(c: Consultation): Promise<boolean> {
    try {
      const unpaid = await this.enrollments.find({ where: { consultationId: c.id, paidOutAt: IsNull() } });
      const { pricePerTokenUsd } = this.tokens.pricing();
      let earnedUsd = 0;
      let earnedTokens = 0;
      for (const e of unpaid) {
        // Claim first (paidOutAt IS NULL -> now) so two overlapping runs can never pay the same enrolment twice.
        const claim = await this.enrollments.update({ id: e.id, paidOutAt: IsNull() }, { paidOutAt: new Date() });
        if (!claim.affected) continue;
        try {
          if (e.paymentReference) {
            // Paid in money: the seller gets the price minus the platform fee, credited to their wallet at the token value.
            const netUsd = roundUsd(e.pricePaidUsd - (e.pricePaidUsd * CONSULTATION_PLATFORM_FEE_PERCENT) / 100);
            const tokens = Math.floor((netUsd / pricePerTokenUsd) * 100) / 100; // never round up: the platform never overpays
            if (tokens > 0) {
              await this.tokens.credit(c.ownerId, tokens, { entryType: 'ADJUSTMENT', label: `consultation:earnings:${shorten(c.title)}`, reference: e.id });
              earnedTokens += tokens;
              earnedUsd += netUsd;
            }
          } else {
            // LEGACY enrolment bought with tokens: pay the seller back in tokens as before.
            const paid = e.pricePaidTokens ?? 0;
            const net = paid - Math.floor((paid * CONSULTATION_PLATFORM_FEE_PERCENT) / 100);
            if (net > 0) {
              await this.tokens.credit(c.ownerId, net, { entryType: 'ADJUSTMENT', label: `consultation:earnings:${shorten(c.title)}`, reference: e.id });
              earnedTokens += net;
              earnedUsd += net * pricePerTokenUsd;
            }
          }
        } catch (err) {
          await this.enrollments.update({ id: e.id }, { paidOutAt: null }); // give the claim back; retried next run
          throw err;
        }
      }
      await this.consultations.delete({ id: c.id }); // enrolments go with it
      if (earnedTokens > 0) {
        await this.notifications.notify(c.ownerId, {
          type: 'SYSTEM',
          title: 'Consultation finished',
          body: `"${c.title}" ended. You earned $${roundUsd(earnedUsd).toFixed(2)} from your students, added to your wallet as ${earnedTokens} token${earnedTokens === 1 ? '' : 's'}.`,
          link: '/consultations',
        });
      }
      return true;
    } catch (err) {
      this.logger.warn(`Could not settle consultation ${c.id}, will retry: ${(err as Error).message}`);
      return false;
    }
  }

  // ---------------------------------------------------------------- helpers

  private async ownedLive(userId: string, id: string): Promise<Consultation> {
    assertValidId(userId, 'User');
    assertValidId(id, 'Consultation');
    const c = await this.consultations.findOne({ where: { id } });
    if (!c || c.endsAt.getTime() <= Date.now()) throw new NotFoundException('Consultation not found');
    if (c.ownerId !== userId) throw new ForbiddenException('You can only change your own consultations.');
    return c;
  }

  /** Checks one session's length (and, for a new or moved session, that it starts in the future and not too far ahead). */
  private checkTimes(startsAt: Date, endsAt: Date, requireFuture: boolean) {
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) throw new BadRequestException('A session start or end time is not valid.');
    const now = Date.now();
    if (requireFuture) {
      if (startsAt.getTime() < now) throw new BadRequestException('Every new or rescheduled session must start in the future.');
      if (startsAt.getTime() > now + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) {
        throw new BadRequestException(`A session can be scheduled at most ${MAX_DAYS_AHEAD} days ahead.`);
      }
    }
    const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
    if (minutes < MIN_DURATION_MINUTES) throw new BadRequestException(`A session must last at least ${MIN_DURATION_MINUTES} minutes.`);
    if (minutes > MAX_DURATION_MINUTES) throw new BadRequestException(`A session can last at most ${MAX_DURATION_MINUTES / 60} hours.`);
  }

  /**
   * Validates a session list and returns it sorted by start time. Sessions may not overlap, the whole programme must
   * fit in MAX_PROGRAM_SPAN_DAYS, and a session that is unchanged from `existing` (same id, same times) is not
   * required to still be in the future - that is how a seminar that has already begun can be edited.
   */
  private normalizeSessions(input: ConsultationSessionDto[], existing: ConsultationSession[]): ParsedSession[] {
    if (input.length === 0) throw new BadRequestException('Add at least one session.');
    if (input.length > MAX_SESSIONS_PER_CONSULTATION) throw new BadRequestException(`A consultation can have at most ${MAX_SESSIONS_PER_CONSULTATION} sessions.`);
    const byId = new Map(existing.map((x) => [x.id, x]));
    const seen = new Set<string>();

    const parsed = input
      .map((x, i): ParsedSession => {
        if (x.id) {
          if (!byId.has(x.id)) throw new BadRequestException(`Session ${i + 1} does not belong to this consultation.`);
          if (seen.has(x.id)) throw new BadRequestException('The same session was sent twice.');
          seen.add(x.id);
        }
        const old = x.id ? byId.get(x.id) : undefined;
        const startsAt = new Date(x.startsAt);
        const endsAt = new Date(x.endsAt);
        const unchanged = !!old && old.startsAt.getTime() === startsAt.getTime() && old.endsAt.getTime() === endsAt.getTime();
        this.checkTimes(startsAt, endsAt, !unchanged);
        return { id: x.id, title: x.title?.trim() || null, startsAt, endsAt, meetLink: x.meetLink ?? null };
      })
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

    for (let i = 1; i < parsed.length; i++) {
      if (parsed[i].startsAt.getTime() < parsed[i - 1].endsAt.getTime()) {
        throw new BadRequestException(`Sessions cannot overlap: session ${i + 1} starts before session ${i} ends.`);
      }
    }
    const spanDays = (parsed[parsed.length - 1].endsAt.getTime() - parsed[0].startsAt.getTime()) / (24 * 60 * 60 * 1000);
    if (spanDays > MAX_PROGRAM_SPAN_DAYS) {
      throw new BadRequestException(`All sessions must fit within ${MAX_PROGRAM_SPAN_DAYS} days (from the first start to the last end).`);
    }
    return parsed;
  }

  /** One-off safety net: a consultation created before sessions existed gets one session from its own start/end. Idempotent. */
  private async backfillSessions() {
    try {
      await this.dataSource.query(
        `INSERT INTO consultation_sessions ("consultationId", position, "startsAt", "endsAt")
         SELECT c.id, 0, c."startsAt", c."endsAt" FROM consultations c
         WHERE NOT EXISTS (SELECT 1 FROM consultation_sessions s WHERE s."consultationId" = c.id)`,
      );
    } catch (err) {
      this.logger.warn(`Could not backfill consultation sessions (run the schema sync first?): ${(err as Error).message}`);
    }
  }

  /** LEGACY (token-bought places only): gives tokens back. When `strict`, a failure is thrown (so a cancel stops); otherwise it is logged. */
  private async refund(userId: string, tokens: number, label: string, reference: string, strict = false) {
    try {
      await this.tokens.credit(userId, tokens, { entryType: 'REFUND', label, reference });
    } catch (err) {
      this.logger.error(`Could not refund ${tokens} token(s) to ${userId} (${label}): ${(err as Error).message}`);
      if (strict) throw err;
    }
  }

  private async notifyStudents(consultationId: string, msg: { title: string; body: string }) {
    const rows = await this.enrollments.find({ where: { consultationId }, select: { buyerId: true } });
    await Promise.all(rows.map((r) => this.notifications.notify(r.buyerId, { type: 'SYSTEM', title: msg.title, body: msg.body, link: '/consultations' })));
  }

  /**
   * What the frontend gets. `meetLink` is included ONLY for the owner and for students who paid; everyone else
   * just sees `hasMeetLink`. The owner's other details never leave the server.
   */
  private async present(rows: Consultation[], viewerId: string | null) {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const counts = await this.enrollments
      .createQueryBuilder('e')
      .select('e."consultationId"', 'id')
      .addSelect('COUNT(*)::int', 'n')
      .addSelect('COALESCE(SUM(CASE WHEN e."paidOutAt" IS NULL AND e."paymentReference" IS NOT NULL THEN e."pricePaidUsd" ELSE 0 END), 0)::float', 'held')
      .where('e."consultationId" IN (:...ids)', { ids })
      .groupBy('e."consultationId"')
      .getRawMany<{ id: string; n: number; held: number }>();
    const countOf = new Map(counts.map((c) => [c.id, c]));
    const mine = viewerId ? await this.enrollments.find({ where: { buyerId: viewerId, consultationId: In(ids) }, select: { consultationId: true } }) : [];
    const enrolledIn = new Set(mine.map((m) => m.consultationId));
    const sessionRows = await this.sessions.find({ where: { consultationId: In(ids) }, order: { startsAt: 'ASC' } });
    const sessionsOf = new Map<string, ConsultationSession[]>();
    for (const x of sessionRows) sessionsOf.set(x.consultationId, [...(sessionsOf.get(x.consultationId) ?? []), x]);
    const now = Date.now();

    return rows.map((c) => {
      const isMine = !!viewerId && c.ownerId === viewerId;
      const isEnrolled = enrolledIn.has(c.id);
      const enrolledCount = Number(countOf.get(c.id)?.n ?? 0);
      const canSee = isMine || isEnrolled;
      // A consultation that somehow has no session rows still shows one session built from its own start and end.
      const list: Pick<ConsultationSession, 'id' | 'title' | 'startsAt' | 'endsAt' | 'meetLink'>[] = sessionsOf.get(c.id) ?? [
        { id: '', title: null, startsAt: c.startsAt, endsAt: c.endsAt, meetLink: null },
      ];
      const sessions = list.map((x, i) => {
        const link = x.meetLink ?? c.meetLink ?? null;
        const done = x.endsAt.getTime() <= now;
        return {
          id: x.id || null,
          position: i,
          title: x.title ?? null,
          startsAt: x.startsAt,
          endsAt: x.endsAt,
          status: done ? 'done' : x.startsAt.getTime() <= now ? 'live' : 'upcoming',
          hasMeetLink: !!link,
          // Same privacy rule as before: only the owner and paying students ever get a link.
          meetLink: canSee ? link : null,
          ownMeetLink: isMine ? x.meetLink ?? null : undefined,
        };
      });
      const nextIndex = sessions.findIndex((x) => x.status !== 'done');
      return {
        id: c.id,
        title: c.title,
        description: c.description,
        category: c.category,
        priceUsd: c.priceUsd,
        capacity: c.capacity ?? null,
        enrolledCount,
        spotsLeft: c.capacity != null ? Math.max(0, c.capacity - enrolledCount) : null,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        // 'live' = a session is on right now; 'ongoing' = the programme has begun but it is between sessions.
        status: sessions.some((x) => x.status === 'live') ? 'live' : c.startsAt.getTime() <= now ? 'ongoing' : 'upcoming',
        sessions,
        sessionCount: sessions.length,
        sessionsDone: sessions.filter((x) => x.status === 'done').length,
        nextSessionIndex: nextIndex >= 0 ? nextIndex : null,
        hostName: c.owner?.firstName?.trim() || (isMine ? 'You' : 'A member'),
        isMine,
        isEnrolled,
        hasMeetLink: sessions.some((x) => x.hasMeetLink),
        meetLink: canSee ? c.meetLink ?? null : null,
        // Only the owner sees what is being held for them.
        heldUsd: isMine ? roundUsd(Number(countOf.get(c.id)?.held ?? 0)) : undefined,
        // Only the owner gets the share link (null = none generated yet).
        shareLink: isMine ? (c.shareCode ? this.shareInfo(c.shareCode).shareLink : null) : undefined,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      };
    });
  }
}

/** Whole cents, without floating-point noise. */
function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function shorten(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
