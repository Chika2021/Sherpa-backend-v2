import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { TOKEN_PACKAGE_IDS } from '../../tokens/token-pricing.config';

/**
 * Exactly one of packageId / tokens / amountUsd is required - they're three
 * ways of asking for the same thing, since every route settles at the same
 * rate ($3 = 5 tokens by default). packageId wins if more than one is sent,
 * then tokens, then amountUsd.
 */
export class InitializePaymentDto {
  /** One of the bundles from GET /payments/config, e.g. "bundle-1" ($3 / 5 tokens). */
  @IsOptional()
  @IsString()
  @IsIn(TOKEN_PACKAGE_IDS)
  packageId?: string;

  /** Custom token count. Must be between minPurchaseTokens and maxPurchaseTokens (see /payments/config). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  tokens?: number;

  /** Alternatively, a dollar amount to spend - converted to whole tokens at the current rate. */
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(1500)
  amountUsd?: number;

  /** Defaults to DEFAULT_CURRENCY (USD). Must be one of ExchangeRateService's currencies. */
  @IsOptional()
  @IsString()
  currency?: string;
}
