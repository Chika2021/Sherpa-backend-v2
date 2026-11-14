import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { User } from '../entities/user.entity';
import { TokenBillingLedger, TokenLedgerEntryType } from '../entities/token-billing-ledger.entity';
import { assertValidId } from '../database/db-utils';
import { isTransientConnectionError } from '../database/transient-errors';
import {
  ResolvedTokenPackage,
  TokenPricing,
  buildTokenPackages,
  maxFeatureTokenCost,
  priceForTokens,
  resolveTokenPricing,
  roundUsd,
  tokenCostForFeature,
} from './token-pricing.config';

export interface TokenLedgerEntry {
  id: string;
  createdAt: string;
  entryType: TokenLedgerEntryType;
  tokens: number;
  usdValue: number;
  balanceAfter: number;
  label: string | null;
  reference: string | null;
}

export interface TokenUsageSummary {
  balance: number;
  pricePerTokenUsd: number;
  totalTokensPurchased: number;
  totalTokensUsed: number;
  totalSpentUsd: number;
  byFeature: Array<{ label: string; tokens: number; usdValue: number }>;
}

export interface TokenChargeResult {
  label: string;
  model: string | null;
  tokensCharged: number;
  usdValue: number;
  balanceAfter: number;
}

export interface TokenCreditResult {
  tokensCredited: number;
  balanceAfter: number;
}

/**
 * The only place a user's token balance is ever mutated.
 *
 * Billing model (see token-pricing.config.ts - change it there, not here):
 * $3 buys 5 tokens, and one AI generation spends 1 token. That's the entire
 * scheme. There is no token "face value" separate from its price, no
 * purchase-side profit split, and no per-model metering of Google's Gemini
 * bill - a token costs $0.60, and a generation costs a token.
 *
 * Every mutation runs in one Postgres transaction that locks the user's row
 * (`SELECT ... FOR UPDATE`), checks the funds, updates the balance and writes
 * the matching ledger row - so two concurrent charges can never take the
 * balance negative, and a balance can always be reconciled by summing the ledger.
 */
@Injectable()
export class TokensService {
  private readonly logger = new Logger(TokensService.name);

  constructor(
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(TokenBillingLedger) private ledger: Repository<TokenBillingLedger>,
    @InjectDataSource() private dataSource: DataSource,
    private config: ConfigService,
  ) {}

  /** Current pricing, resolved from env each call so a rate change needs no restart. */
  pricing(): TokenPricing {
    return resolveTokenPricing((key) => this.config.get(key));
  }

  packages(): ResolvedTokenPackage[] {
    return buildTokenPackages(this.pricing());
  }

  /** What one call to `label` costs, in tokens. */
  costForFeature(label?: string | null): number {
    return tokenCostForFeature(label);
  }

  async getBalance(userId: string): Promise<number> {
    assertValidId(userId, 'User');
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, tokens: true } });
    if (!user) throw new NotFoundException('User not found');
    return Number(user.tokens);
  }

  /**
   * Gate to call BEFORE a billable Gemini request: fails fast instead of
   * letting the app pay Google for a generation it can't collect for. Checks
   * the exact cost of the feature about to run, falling back to the most
   * expensive feature's cost when no label is given.
   */
  async assertCanAfford(userId: string, label?: string | null): Promise<true> {
    const required = label ? this.costForFeature(label) : maxFeatureTokenCost();
    const balance = await this.getBalance(userId);
    if (balance < required) {
      throw new BadRequestException(
        `Not enough tokens. This needs ${required} token${required === 1 ? '' : 's'} and you have ${balance}. Top up to continue.`,
      );
    }
    return true;
  }

  /**
   * Shared atomic core: moves the balance by `delta` tokens (negative to
   * spend) and writes the matching ledger row in one transaction, so a
   * balance change is never recorded without its ledger entry or vice versa.
   *
   */
  private async applyDelta(
    userId: string,
    delta: number,
    entry: {
      entryType: TokenLedgerEntryType;
      label: string | null;
      model?: string | null;
      reference?: string | null;
    },
  ): Promise<number> {
    assertValidId(userId, 'User');
    const { pricePerTokenUsd } = this.pricing();

    // One id for every attempt: if the connection drops AFTER the transaction committed but before we got the
    // answer, the retry finds this ledger row and returns its result instead of charging twice.
    const ledgerId = uuid();
    const ATTEMPTS = 3;
    const RETRY_DELAYS_MS = [300, 900];

    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await this.dataSource.transaction(async (em) => {
          const already = await em.findOne(TokenBillingLedger, { where: { id: ledgerId }, select: { id: true, balanceAfter: true } });
          if (already) return Number(already.balanceAfter);

          // Row lock: concurrent charges for the same user queue up here, so the
          // funds check below is always made against the latest balance.
          const user = await em.findOne(User, {
            where: { id: userId },
            select: { id: true, tokens: true },
            lock: { mode: 'pessimistic_write' },
          });
          if (!user) throw new NotFoundException('User not found');

          const balanceAfter = Number(user.tokens) + delta;
          if (delta < 0 && balanceAfter < 0) {
            throw new BadRequestException('Not enough tokens. Top up to continue.');
          }

          await em.update(User, { id: userId }, { tokens: balanceAfter });
          await em.insert(TokenBillingLedger, {
            id: ledgerId,
            userId,
            entryType: entry.entryType,
            tokens: delta,
            usdValue: roundUsd(delta * pricePerTokenUsd),
            pricePerTokenUsd,
            balanceAfter,
            label: entry.label,
            model: entry.model ?? null,
            reference: entry.reference ?? null,
          });
          return balanceAfter;
        });
      } catch (err) {
        if (err instanceof BadRequestException || err instanceof NotFoundException) throw err;
        if (attempt < ATTEMPTS && isTransientConnectionError(err)) {
          const delay = RETRY_DELAYS_MS[attempt - 1];
          this.logger.warn(
            `Token ledger write hit a dropped database connection for user ${userId}; retrying (${attempt}/${ATTEMPTS - 1}) in ${delay}ms.`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        this.logger.error(`Token ledger write failed for user ${userId}: ${(err as Error).message}`);
        throw new InternalServerErrorException('Could not record the token transaction. Please try again.');
      }
    }
    throw new InternalServerErrorException('Could not record the token transaction. Please try again.');
  }

  /**
   * Credits tokens. Called by PaymentsService after a verified Paystack
   * payment (entryType PURCHASE), and by AuthService for the signup bonus
   * (BONUS). `reference` ties a PURCHASE row back to its payment.
   */
  async credit(
    userId: string,
    tokens: number,
    options: {
      entryType?: Extract<TokenLedgerEntryType, 'PURCHASE' | 'BONUS' | 'REFUND' | 'ADJUSTMENT'>;
      label?: string | null;
      reference?: string | null;
    } = {},
  ): Promise<TokenCreditResult> {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new BadRequestException('Token amount must be a positive number');
    }
    const balanceAfter = await this.applyDelta(userId, tokens, {
      entryType: options.entryType ?? 'PURCHASE',
      label: options.label ?? null,
      reference: options.reference ?? null,
    });
    return { tokensCredited: tokens, balanceAfter };
  }

  /**
   * Charges for one AI generation: looks up the feature's cost (1 token for
   * everything, by default) and spends it. Throws BadRequestException if the
   * balance can't cover it - callers that have already paid Google for the
   * response should catch that rather than discard the response (see
   * GeminiService.chargeForUsage).
   */
  async charge(
    userId: string,
    billing: { label: string; model?: string | null },
  ): Promise<TokenChargeResult> {
    const tokensCharged = this.costForFeature(billing.label);
    const balanceAfter = await this.applyDelta(userId, -tokensCharged, {
      entryType: 'USAGE',
      label: billing.label,
      model: billing.model ?? null,
    });
    return {
      label: billing.label,
      model: billing.model ?? null,
      tokensCharged,
      usdValue: priceForTokens(tokensCharged, this.pricing()),
      balanceAfter,
    };
  }

  /**
   * Generic debit for anything that isn't a Gemini call (e.g. charging per
   * submission). Same ledger treatment as `charge`.
   */
  async spend(userId: string, tokens: number, label: string): Promise<number> {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new BadRequestException('Token amount must be a positive number');
    }
    return this.applyDelta(userId, -tokens, { entryType: 'USAGE', label });
  }

  /** Full ledger (purchases and usage), newest first. */
  async getLedger(userId: string, limit = 50, entryType?: TokenLedgerEntryType): Promise<TokenLedgerEntry[]> {
    assertValidId(userId, 'User');
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50;

    const rows = await this.ledger.find({
      where: entryType ? { userId, entryType } : { userId },
      order: { createdAt: 'DESC' },
      take: safeLimit,
      select: {
        id: true,
        entryType: true,
        tokens: true,
        usdValue: true,
        balanceAfter: true,
        label: true,
        reference: true,
        createdAt: true,
      },
    });

    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      entryType: r.entryType,
      tokens: r.tokens,
      usdValue: r.usdValue,
      balanceAfter: r.balanceAfter,
      label: r.label ?? null,
      reference: r.reference ?? null,
    }));
  }

  /** Usage-only history - what the "AI usage" list on the wallet screen shows. */
  getUsageHistory(userId: string, limit = 50): Promise<TokenLedgerEntry[]> {
    return this.getLedger(userId, limit, 'USAGE');
  }

  /** All-time totals plus a per-feature breakdown, for the wallet summary cards. */
  async getUsageSummary(userId: string): Promise<TokenUsageSummary> {
    assertValidId(userId, 'User');
    const { pricePerTokenUsd } = this.pricing();

    const [balance, rows] = await Promise.all([
      this.getBalance(userId),
      this.ledger
        .createQueryBuilder('l')
        .select('l.entryType', 'entryType')
        .addSelect('l.label', 'label')
        .addSelect('SUM(l.tokens)', 'tokens')
        .where('l.userId = :userId', { userId })
        .groupBy('l.entryType')
        .addGroupBy('l.label')
        .getRawMany<{ entryType: string; label: string | null; tokens: string | number }>(),
    ]);

    const usageRows = rows.filter((r) => r.entryType === 'USAGE');
    const purchasedTokens = rows
      .filter((r) => r.entryType === 'PURCHASE')
      .reduce((sum, r) => sum + Number(r.tokens), 0);

    // Usage rows are stored negative - flip them so the UI gets plain positives.
    const byFeature = usageRows
      .map((r) => ({
        label: r.label ?? 'Other',
        tokens: Math.abs(Number(r.tokens)),
        usdValue: roundUsd(Math.abs(Number(r.tokens)) * pricePerTokenUsd),
      }))
      .sort((a, b) => b.tokens - a.tokens);

    const totalTokensUsed = byFeature.reduce((sum, r) => sum + r.tokens, 0);

    return {
      balance,
      pricePerTokenUsd,
      totalTokensPurchased: purchasedTokens,
      totalTokensUsed,
      totalSpentUsd: roundUsd(totalTokensUsed * pricePerTokenUsd),
      byFeature,
    };
  }
}
