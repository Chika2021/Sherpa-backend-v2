import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Converts a USD amount into another currency using a static rate table.
 *
 * IMPORTANT: these are fixed, illustrative rates - fine to get the payment
 * flow working end-to-end, but real exchange rates move daily. For
 * production, replace `loadRates()` with a call to a live FX provider (e.g.
 * exchangerate.host, Open Exchange Rates, or your bank's published rate) on
 * an interval, or at minimum update EXCHANGE_RATES_JSON regularly.
 *
 * Only currencies Paystack actually supports charging in should be listed
 * here - which ones are available depends on your Paystack business's
 * country and settlement currency approvals, not just on this list. Check
 * your Paystack dashboard before assuming a currency is chargeable.
 */
@Injectable()
export class ExchangeRateService {
  private readonly logger = new Logger(ExchangeRateService.name);
  private rates: Record<string, number>;

  constructor(private config: ConfigService) {
    this.rates = this.loadRates();
  }

  private loadRates(): Record<string, number> {
    const raw = this.config.get<string>('EXCHANGE_RATES_JSON');
    const fallback = { USD: 1, NGN: 1500, GHS: 15, ZAR: 18, KES: 129 };
    if (!raw) return fallback;
    try {
      return { USD: 1, ...JSON.parse(raw) };
    } catch {
      this.logger.warn('EXCHANGE_RATES_JSON is not valid JSON - falling back to built-in defaults.');
      return fallback;
    }
  }

  supportedCurrencies(): string[] {
    return Object.keys(this.rates);
  }

  isSupported(currency: string): boolean {
    return !!this.rates[currency.toUpperCase()];
  }

  /** Converts a USD amount to the target currency's major unit (e.g. dollars -> naira). */
  toCurrency(amountUsd: number, currency: string): number {
    const code = currency.toUpperCase();
    const rate = this.rates[code];
    if (!rate) {
      throw new BadRequestException(
        `Unsupported currency "${currency}". Supported: ${this.supportedCurrencies().join(', ')}`,
      );
    }
    return Math.round(amountUsd * rate * 100) / 100;
  }
}
