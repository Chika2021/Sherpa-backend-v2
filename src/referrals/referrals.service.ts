import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as crypto from 'crypto';
import { Repository } from 'typeorm';
import { Referral, User } from '../entities';
import { assertValidId } from '../database/db-utils';
import { maskEmail, RequestFingerprint } from '../common/identity.util';
import { TokensService } from '../tokens/tokens.service';
import { NotificationsService } from '../notifications/notifications.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import {
  REFERRAL_BLOCK_SAME_DEVICE,
  REFERRAL_BLOCK_SAME_IP,
  REFERRAL_FIRST_PURCHASE_REWARD_TOKENS,
  REFERRAL_SIGNUP_BONUS_TOKENS,
  REFERRAL_SIGNUP_REWARD_CAP_TOKENS,
  REFERRAL_VERIFIED_REWARD_TOKENS,
} from '../tokens/token-pricing.config';

// No I, O, 0 or 1: a code read aloud or typed from a screenshot is never ambiguous.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** Ledger labels. All start with "referral:" so every referral movement can be listed (and reversed) with one filter. */
export const REFERRAL_LABELS = {
  signup: 'referral:signup',
  verified: 'referral:verified',
  purchase: 'referral:purchase',
  reversal: 'referral:reversal',
} as const;

export interface ReferralApplyResult {
  applied: boolean;
  bonusTokens: number;
  message?: string;
}

/**
 * The referral programme.
 *   friend signs up through a link ........ friend gets +REFERRAL_SIGNUP_BONUS_TOKENS (on top of the normal signup tokens)
 *   friend verifies their email ........... referrer gets REFERRAL_VERIFIED_REWARD_TOKENS (capped per referrer)
 *   friend makes their first purchase ..... referrer gets REFERRAL_FIRST_PURCHASE_REWARD_TOKENS (uncapped, paid from revenue)
 * Every reward goes through TokensService.credit, so it lands in the token ledger with a "referral:" label.
 * Amounts and caps are in src/tokens/token-pricing.config.ts.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private config: ConfigService,
    private tokens: TokensService,
    private notifications: NotificationsService,
    private monitoring: MonitoringService,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Referral) private referrals: Repository<Referral>,
  ) {}

  // ---------------------------------------------------------------- codes

  /** A fresh code nobody has. 32^8 combinations, so a clash is vanishingly rare, but it is still checked. */
  async uniqueCode(): Promise<string> {
    for (let i = 0; i < 6; i++) {
      let code = '';
      for (let j = 0; j < CODE_LENGTH; j++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!(await this.users.existsBy({ referralCode: code }))) return code;
    }
    throw new Error('Could not generate a unique referral code');
  }

  /** "abcd-2345 " -> "ABCD2345", or null when it cannot be a code. */
  normalizeCode(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return code.length >= 4 && code.length <= 16 ? code : null;
  }

  /** Accounts created before referrals existed get their code the first time they open the invite screen. */
  private async ensureCode(userId: string): Promise<string> {
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, referralCode: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.referralCode) return user.referralCode;
    for (let i = 0; i < 3; i++) {
      const code = await this.uniqueCode();
      // Only fills an EMPTY code, so two simultaneous requests cannot overwrite each other.
      const res = await this.users
        .createQueryBuilder()
        .update()
        .set({ referralCode: code })
        .where('id = :id AND "referralCode" IS NULL', { id: userId })
        .execute();
      if (res.affected) return code;
      const again = await this.users.findOne({ where: { id: userId }, select: { id: true, referralCode: true } });
      if (again?.referralCode) return again.referralCode;
    }
    throw new BadRequestException('Could not create your referral code. Please try again.');
  }

  private linkFor(code: string): string {
    const base = (this.config.get<string>('FRONTEND_URL') || this.config.get<string>('APP_URL') || 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/register?ref=${code}`;
  }

  // ---------------------------------------------------------------- 1) signup through a link

  /**
   * Called right after a new account is created. Never throws: a problem with the referral must not fail the sign-up.
   * Blocks self-referrals (same mailbox, same device, optionally same network) and records every attempt.
   */
  async applyAtSignup(
    referee: Pick<User, 'id' | 'email' | 'createdAt'>,
    rawCode: unknown,
    ctx: { fp: RequestFingerprint; canonical: string },
  ): Promise<ReferralApplyResult> {
    const code = this.normalizeCode(rawCode);
    if (!code) return { applied: false, bonusTokens: 0 };
    const invalid: ReferralApplyResult = { applied: false, bonusTokens: 0, message: "That referral link isn't valid, so no bonus was added." };

    try {
      const referrer = await this.users
        .createQueryBuilder('u')
        .addSelect(['u.emailCanonical', 'u.signupIpHash', 'u.signupDeviceHash', 'u.lastIpHash', 'u.lastDeviceHash'])
        .where('u."referralCode" = :code', { code })
        .getOne();
      if (!referrer || referrer.id === referee.id || referrer.suspended) return invalid;

      const sameEmail = referrer.emailCanonical === ctx.canonical;
      const sameDevice = !!ctx.fp.deviceHash && (ctx.fp.deviceHash === referrer.signupDeviceHash || ctx.fp.deviceHash === referrer.lastDeviceHash);
      const sameIp = !!ctx.fp.ipHash && (ctx.fp.ipHash === referrer.signupIpHash || ctx.fp.ipHash === referrer.lastIpHash);

      const blockedBy: 'EMAIL' | 'DEVICE' | 'IP' | null = sameEmail
        ? 'EMAIL'
        : sameDevice && REFERRAL_BLOCK_SAME_DEVICE
          ? 'DEVICE'
          : sameIp && REFERRAL_BLOCK_SAME_IP
            ? 'IP'
            : null;

      if (blockedBy) {
        await this.referrals
          .save(
            this.referrals.create({
              referrerId: referrer.id,
              referredUserId: referee.id,
              code,
              status: 'REJECTED',
              rejectedReason: `Self-referral blocked (${blockedBy.toLowerCase()} match)`,
            }),
          )
          .catch(() => undefined);
        void this.monitoring.onSuspiciousReferral({ referee, referrer, kind: blockedBy, blocked: true, maskedIp: ctx.fp.maskedIp });
        return { applied: false, bonusTokens: 0, message: "This referral link can't be used for your account, so no referral bonus was added." };
      }

      // Accepted. (A shared device that is not blocked, or a shared IP, still gets flagged for a human to look at.)
      const referral = await this.referrals.save(
        this.referrals.create({ referrerId: referrer.id, referredUserId: referee.id, code, status: 'PENDING' }),
      );
      await this.users.update({ id: referee.id }, { referredBy: referrer.id });

      let bonus = 0;
      if (REFERRAL_SIGNUP_BONUS_TOKENS > 0) {
        try {
          await this.tokens.credit(referee.id, REFERRAL_SIGNUP_BONUS_TOKENS, {
            entryType: 'BONUS',
            label: REFERRAL_LABELS.signup,
            reference: referral.id,
          });
          bonus = REFERRAL_SIGNUP_BONUS_TOKENS;
          await this.referrals.update({ id: referral.id }, { signupBonusTokens: bonus });
        } catch (err) {
          this.logger.error(`Referral signup bonus failed for ${referee.id}: ${(err as Error).message}`);
        }
      }

      if (sameDevice || sameIp) {
        void this.monitoring.onSuspiciousReferral({ referee, referrer, kind: sameDevice ? 'DEVICE' : 'IP', blocked: false, maskedIp: ctx.fp.maskedIp });
      }
      void this.notifications.notify(referrer.id, {
        type: 'REFERRAL',
        title: 'A friend joined with your link',
        body: `Someone signed up using your referral link. You'll earn ${REFERRAL_VERIFIED_REWARD_TOKENS} tokens when they verify their email, and ${REFERRAL_FIRST_PURCHASE_REWARD_TOKENS} more when they make their first purchase.`,
        link: '/billing?tab=invite',
        meta: { referralId: referral.id },
      });
      void this.monitoring.onReferralJoined(referrer.id);

      return {
        applied: true,
        bonusTokens: bonus,
        message: bonus ? `Referral applied: ${bonus} bonus tokens added.` : 'Referral applied.',
      };
    } catch (err) {
      // Most likely the unique index on referredUserId (this user was already referred) - never an error for the user.
      this.logger.warn(`Referral at signup failed for ${referee.id}: ${(err as Error).message}`);
      return { applied: false, bonusTokens: 0 };
    }
  }

  // ---------------------------------------------------------------- 2) friend verified their email

  /** Pays the referrer for a verified friend. Safe to call repeatedly: it pays at most once per friend. Never throws. */
  async onEmailVerified(userId: string): Promise<void> {
    try {
      const referral = await this.referrals.findOne({ where: { referredUserId: userId } });
      if (!referral || referral.status !== 'PENDING' || referral.verifyRewardedAt) return;

      const referrer = await this.users.findOne({ where: { id: referral.referrerId }, select: { id: true, email: true, suspended: true } });
      const friend = await this.users.findOne({ where: { id: userId }, select: { id: true, email: true, suspended: true } });
      if (!referrer || referrer.suspended || !friend || friend.suspended) return; // stays PENDING; paid if the account is reinstated and re-verified

      // Reserve the reward and enforce the per-referrer cap in one locked step, so two friends verifying at the
      // same instant cannot both squeeze under the cap.
      const reserved = await this.referrals.manager.transaction(async (em) => {
        await em.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`referral-cap:${referral.referrerId}`]);
        const fresh = await em.findOne(Referral, { where: { id: referral.id } });
        if (!fresh || fresh.status !== 'PENDING' || fresh.verifyRewardedAt) return null;

        const row = (await em
          .createQueryBuilder(Referral, 'r')
          .select('COALESCE(SUM(r."verifyRewardTokens"), 0)', 'earned')
          .where('r."referrerId" = :id AND r.status <> :rejected', { id: fresh.referrerId, rejected: 'REJECTED' })
          .getRawOne()) as { earned: string } | undefined;
        const earned = Number(row?.earned ?? 0);
        const amount = Math.max(0, Math.min(REFERRAL_VERIFIED_REWARD_TOKENS, REFERRAL_SIGNUP_REWARD_CAP_TOKENS - earned));

        await em.update(Referral, { id: fresh.id }, { status: 'VERIFIED', verifyRewardTokens: amount, verifyRewardedAt: new Date() });
        return { amount, capped: amount < REFERRAL_VERIFIED_REWARD_TOKENS };
      });
      if (!reserved) return;

      if (reserved.amount > 0) {
        try {
          await this.tokens.credit(referral.referrerId, reserved.amount, {
            entryType: 'BONUS',
            label: REFERRAL_LABELS.verified,
            reference: referral.id,
          });
        } catch (err) {
          // Give the reservation back so a later verification attempt can pay it.
          await this.referrals.update({ id: referral.id }, { status: 'PENDING', verifyRewardTokens: 0, verifyRewardedAt: null });
          this.logger.error(`Referral verify reward failed for referrer ${referral.referrerId}: ${(err as Error).message}`);
          return;
        }
      }

      void this.notifications.notify(referral.referrerId, {
        type: 'REFERRAL',
        title: reserved.amount > 0 ? `You earned ${reserved.amount} tokens` : 'Referral limit reached',
        body:
          reserved.amount > 0
            ? `${maskEmail(friend.email)} verified their email. You'll earn ${REFERRAL_FIRST_PURCHASE_REWARD_TOKENS} more tokens when they make their first purchase.`
            : `${maskEmail(friend.email)} verified their email, but you've reached the ${REFERRAL_SIGNUP_REWARD_CAP_TOKENS}-token limit on sign-up rewards. You still earn ${REFERRAL_FIRST_PURCHASE_REWARD_TOKENS} tokens when a friend makes their first purchase.`,
        link: '/billing?tab=invite',
        meta: { referralId: referral.id },
      });
    } catch (err) {
      this.logger.warn(`Referral verify step failed for ${userId}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- 3) friend's first purchase

  /** Pays the referrer when the friend's first token purchase succeeds. Pays at most once per friend. Never throws. */
  async onFirstPurchase(userId: string, paymentReference: string): Promise<void> {
    try {
      const referral = await this.referrals.findOne({ where: { referredUserId: userId } });
      if (!referral || referral.status === 'REJECTED' || referral.purchaseRewardedAt) return;

      const referrer = await this.users.findOne({ where: { id: referral.referrerId }, select: { id: true, suspended: true } });
      if (!referrer || referrer.suspended) return;

      // Atomic claim: only one caller (webhook or verify-on-return) can flip purchaseRewardedAt from NULL.
      const claim = await this.referrals
        .createQueryBuilder()
        .update(Referral)
        .set({ status: 'PURCHASED', purchaseRewardTokens: REFERRAL_FIRST_PURCHASE_REWARD_TOKENS, purchaseRewardedAt: new Date() })
        .where('id = :id AND "purchaseRewardedAt" IS NULL AND status <> :rejected', { id: referral.id, rejected: 'REJECTED' })
        .execute();
      if (!claim.affected) return;

      try {
        await this.tokens.credit(referral.referrerId, REFERRAL_FIRST_PURCHASE_REWARD_TOKENS, {
          entryType: 'BONUS',
          label: REFERRAL_LABELS.purchase,
          reference: paymentReference,
        });
      } catch (err) {
        await this.referrals.update(
          { id: referral.id },
          { status: referral.verifyRewardedAt ? 'VERIFIED' : 'PENDING', purchaseRewardTokens: 0, purchaseRewardedAt: null },
        );
        this.logger.error(`Referral purchase reward failed for referrer ${referral.referrerId}: ${(err as Error).message}`);
        return;
      }

      void this.notifications.notify(referral.referrerId, {
        type: 'REFERRAL',
        title: `You earned ${REFERRAL_FIRST_PURCHASE_REWARD_TOKENS} tokens`,
        body: 'A friend you invited just made their first purchase. Thank you for spreading the word!',
        link: '/billing?tab=invite',
        meta: { referralId: referral.id },
      });
    } catch (err) {
      this.logger.warn(`Referral purchase step failed for ${userId}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- the user's own invite screen

  async myReferral(userId: string) {
    assertValidId(userId, 'User');
    const code = await this.ensureCode(userId);

    const rows = await this.referrals.find({
      where: { referrerId: userId },
      relations: { referred: true },
      order: { createdAt: 'DESC' },
      take: 200,
    });
    const counted = rows.filter((r) => r.status !== 'REJECTED');
    const verifyEarned = counted.reduce((s, r) => s + Number(r.verifyRewardTokens), 0);
    const purchaseEarned = counted.reduce((s, r) => s + Number(r.purchaseRewardTokens), 0);

    const link = this.linkFor(code);
    return {
      code,
      link,
      shareText: `I use Sherpar to land jobs faster. Join with my link and get ${REFERRAL_SIGNUP_BONUS_TOKENS} extra free tokens: ${link}`,
      rewards: {
        friendBonusTokens: REFERRAL_SIGNUP_BONUS_TOKENS,
        verifiedRewardTokens: REFERRAL_VERIFIED_REWARD_TOKENS,
        firstPurchaseRewardTokens: REFERRAL_FIRST_PURCHASE_REWARD_TOKENS,
        signupRewardCapTokens: REFERRAL_SIGNUP_REWARD_CAP_TOKENS,
      },
      stats: {
        friendsJoined: counted.length,
        friendsVerified: counted.filter((r) => r.status === 'VERIFIED' || r.status === 'PURCHASED').length,
        friendsPurchased: counted.filter((r) => r.status === 'PURCHASED').length,
        tokensEarned: verifyEarned + purchaseEarned,
        signupRewardsEarned: verifyEarned,
        signupRewardsRemaining: Math.max(0, REFERRAL_SIGNUP_REWARD_CAP_TOKENS - verifyEarned),
      },
      // Friends are shown by first name or a masked address: enough to recognise them, not enough to harvest.
      friends: counted.slice(0, 50).map((r) => ({
        id: r.id,
        name: r.referred?.firstName?.trim() || (r.referred ? maskEmail(r.referred.email) : 'A friend'),
        status: r.status,
        joinedAt: r.createdAt,
        tokensEarned: Number(r.verifyRewardTokens) + Number(r.purchaseRewardTokens),
      })),
    };
  }

  // ---------------------------------------------------------------- admin

  async adminList(userId?: string) {
    const qb = this.referrals
      .createQueryBuilder('r')
      .leftJoinAndSelect('r.referrer', 'referrer')
      .leftJoinAndSelect('r.referred', 'referred')
      .orderBy('r."createdAt"', 'DESC')
      .take(100);
    if (userId) {
      assertValidId(userId, 'User');
      qb.where('(r."referrerId" = :userId OR r."referredUserId" = :userId)', { userId });
    }
    const rows = await qb.getMany();
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      code: r.code,
      createdAt: r.createdAt,
      referrer: { id: r.referrerId, email: r.referrer?.email ?? null },
      referred: { id: r.referredUserId, email: r.referred?.email ?? null },
      signupBonusTokens: r.signupBonusTokens,
      verifyRewardTokens: r.verifyRewardTokens,
      purchaseRewardTokens: r.purchaseRewardTokens,
      rejectedReason: r.rejectedReason ?? null,
      reversedAt: r.reversedAt ?? null,
    }));
  }

  /**
   * Takes back everything one referral paid out (the friend's signup bonus and the referrer's rewards), as
   * "referral:reversal" ledger entries, for when someone cheated. Only what is still in the balance can be taken back.
   */
  async reverse(actor: { id: string; role: string }, referralId: string, note?: string) {
    if (actor.role !== 'SUPER_ADMIN') throw new ForbiddenException('Only the super admin can reverse referral rewards.');
    assertValidId(referralId, 'Referral');
    const referral = await this.referrals.findOneBy({ id: referralId });
    if (!referral) throw new NotFoundException('Referral not found');
    if (referral.reversedAt) throw new BadRequestException('This referral was already reversed.');

    const takeBack = async (userId: string, wanted: number) => {
      if (wanted <= 0) return 0;
      const balance = await this.tokens.getBalance(userId).catch(() => 0);
      const amount = Math.min(wanted, balance);
      if (amount <= 0) return 0;
      await this.tokens.debit(userId, amount, { entryType: 'ADJUSTMENT', label: REFERRAL_LABELS.reversal });
      return amount;
    };

    const friend = await takeBack(referral.referredUserId, Number(referral.signupBonusTokens));
    const referrer = await takeBack(referral.referrerId, Number(referral.verifyRewardTokens) + Number(referral.purchaseRewardTokens));

    await this.referrals.update(
      { id: referral.id },
      {
        status: 'REJECTED',
        reversedAt: new Date(),
        rejectedReason: (note?.trim() || 'Reversed by an admin').slice(0, 300),
      },
    );
    return { reversed: true, tokensRemovedFromFriend: friend, tokensRemovedFromReferrer: referrer };
  }
}
