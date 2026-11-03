import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TokensService } from './tokens.service';
import { TOKEN_LEDGER_ENTRY_TYPES, TokenLedgerEntryType } from '../entities/token-billing-ledger.entity';
import { FEATURE_TOKEN_COSTS, DEFAULT_FEATURE_TOKEN_COST } from './token-pricing.config';

/**
 * Wallet endpoints: what a user has, what it cost, and how it's being spent.
 * Buying more tokens lives on PaymentsController (/payments/*).
 */
@Controller('tokens')
export class TokensController {
  constructor(private tokensService: TokensService) {}

  /**
   * Public pricing - safe to show before login. Everything derives from the
   * one rule: BUNDLE_PRICE_USD buys BUNDLE_TOKENS tokens (default $3 = 5),
   * and one AI generation costs one token.
   */
  @Get('pricing')
  pricing() {
    const pricing = this.tokensService.pricing();
    return {
      bundlePriceUsd: pricing.bundlePriceUsd,
      bundleTokens: pricing.bundleTokens,
      pricePerTokenUsd: pricing.pricePerTokenUsd,
      minPurchaseTokens: pricing.minPurchaseTokens,
      maxPurchaseTokens: pricing.maxPurchaseTokens,
      packages: this.tokensService.packages(),
      defaultFeatureCost: DEFAULT_FEATURE_TOKEN_COST,
      featureCosts: FEATURE_TOKEN_COSTS,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Get('balance')
  async balance(@CurrentUser('id') userId: string) {
    const tokens = await this.tokensService.getBalance(userId);
    const { pricePerTokenUsd } = this.tokensService.pricing();
    return { tokens, pricePerTokenUsd };
  }

  /** Every balance movement (purchases, bonuses, usage), newest first. ?limit=1-200, ?type=USAGE */
  @UseGuards(JwtAuthGuard)
  @Get('ledger')
  ledger(
    @CurrentUser('id') userId: string,
    @Query('limit') limit?: string,
    @Query('type') type?: string,
  ) {
    const entryType = TOKEN_LEDGER_ENTRY_TYPES.includes(type as TokenLedgerEntryType)
      ? (type as TokenLedgerEntryType)
      : undefined;
    return this.tokensService.getLedger(userId, limit ? Number(limit) : undefined, entryType);
  }

  /** Usage-only history, newest first. ?limit=1-200, default 50. */
  @UseGuards(JwtAuthGuard)
  @Get('usage')
  usage(@CurrentUser('id') userId: string, @Query('limit') limit?: string) {
    return this.tokensService.getUsageHistory(userId, limit ? Number(limit) : undefined);
  }

  /** All-time totals plus a per-feature breakdown. */
  @UseGuards(JwtAuthGuard)
  @Get('usage/summary')
  usageSummary(@CurrentUser('id') userId: string) {
    return this.tokensService.getUsageSummary(userId);
  }
}
