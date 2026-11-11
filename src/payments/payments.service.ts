import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PaystackService } from '../paystack/paystack.service';
import { ExchangeRateService } from './exchange-rate.service';
import { TokensService } from '../tokens/tokens.service';
import { InitializePaymentDto } from './dto/initialize-payment.dto';
import { findTokenPackage, priceForTokens, tokensForUsd } from '../tokens/token-pricing.config';
import { PaymentTransaction } from '../entities/payment-transaction.entity';
import { User } from '../entities/user.entity';
import { assertValidId } from '../database/db-utils';

/**
 * Buying tokens. The pricing rule is deliberately trivial and lives in one
 * file (src/tokens/token-pricing.config.ts): **$3 buys 5 tokens**, i.e.
 * $0.60 per token, at every bundle size and for custom amounts alike. No
 * bundle discounts, no split between "what you pay" and "what the token is
 * worth" - the price IS the value, and the margin is simply the difference
 * between $0.60 and what a Gemini call actually costs us.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(PaymentTransaction) private transactions: Repository<PaymentTransaction>,
    @InjectRepository(User) private users: Repository<User>,
    private config: ConfigService,
    private paystack: PaystackService,
    private exchangeRates: ExchangeRateService,
    private tokens: TokensService,
  ) {}

  private defaultCurrency(): string {
    return (this.config.get<string>('DEFAULT_CURRENCY') || 'USD').toUpperCase();
  }

  /** Everything the buy screen needs before it can render. */
  getPublicConfig() {
    const pricing = this.tokens.pricing();
    return {
      publicKey: this.config.get<string>('PAYSTACK_PUBLIC_KEY') || null,
      defaultCurrency: this.defaultCurrency(),
      supportedCurrencies: this.exchangeRates.supportedCurrencies(),
      bundlePriceUsd: pricing.bundlePriceUsd,
      bundleTokens: pricing.bundleTokens,
      pricePerTokenUsd: pricing.pricePerTokenUsd,
      minPurchaseTokens: pricing.minPurchaseTokens,
      maxPurchaseTokens: pricing.maxPurchaseTokens,
      packages: this.tokens.packages(),
    };
  }

  /**
   * Works out how many tokens this request is for, from whichever of the
   * three inputs the client sent: a package id, an explicit token count, or
   * a dollar amount to spend. All three settle on the same per-token rate.
   */
  private resolveTokenCount(dto: InitializePaymentDto): { tokenCount: number; packageId: string | null } {
    const pricing = this.tokens.pricing();

    if (dto.packageId) {
      const pkg = findTokenPackage(dto.packageId, pricing);
      if (!pkg) throw new BadRequestException(`Unknown package "${dto.packageId}"`);
      return { tokenCount: pkg.tokens, packageId: pkg.id };
    }

    let tokenCount: number;
    if (dto.tokens != null) {
      tokenCount = Math.floor(dto.tokens);
    } else if (dto.amountUsd != null) {
      tokenCount = tokensForUsd(dto.amountUsd, pricing);
    } else {
      throw new BadRequestException('Provide a packageId, a tokens amount, or an amountUsd');
    }

    if (tokenCount < pricing.minPurchaseTokens) {
      throw new BadRequestException(
        `The smallest top-up is ${pricing.minPurchaseTokens} tokens ($${priceForTokens(pricing.minPurchaseTokens, pricing)}).`,
      );
    }
    if (tokenCount > pricing.maxPurchaseTokens) {
      throw new BadRequestException(`The largest single top-up is ${pricing.maxPurchaseTokens} tokens.`);
    }

    return { tokenCount, packageId: null };
  }

  /** Starts a purchase: creates a PENDING transaction and returns a Paystack checkout URL. */
  async initialize(userId: string, dto: InitializePaymentDto) {
    assertValidId(userId, 'User');
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');

    const currency = (dto.currency || this.defaultCurrency()).toUpperCase();
    if (!this.exchangeRates.isSupported(currency)) {
      throw new BadRequestException(
        `Currency "${currency}" is not supported. Supported: ${this.exchangeRates.supportedCurrencies().join(', ')}`,
      );
    }

    const pricing = this.tokens.pricing();
    const { tokenCount, packageId } = this.resolveTokenCount(dto);

    const amountUsd = priceForTokens(tokenCount, pricing);
    const amount = currency === 'USD' ? amountUsd : this.exchangeRates.toCurrency(amountUsd, currency);

    const reference = `tok_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const transaction = await this.transactions.save(this.transactions.create({
      userId,
      payerEmail: user.email,
      payerName: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      reference,
      tokensRequested: tokenCount,
      packageId,
      pricePerTokenUsd: pricing.pricePerTokenUsd,
      amountUsd,
      amount,
      currency,
      status: 'PENDING',
    }));

    // Paystack wants an integer in the currency's smallest unit (cents/kobo).
    const minorAmount = Math.round(amount * 100);

    const paystackRes = await this.paystack.initializeTransaction({
      email: user.email,
      amount: minorAmount,
      currency,
      reference,
      callback_url: this.config.get<string>('PAYMENT_CALLBACK_URL'),
      metadata: { userId, tokensRequested: tokenCount, packageId, transactionId: transaction.id },
    });

    return {
      reference,
      amount,
      amountUsd,
      currency,
      tokensRequested: tokenCount,
      packageId,
      pricePerTokenUsd: pricing.pricePerTokenUsd,
      authorizationUrl: paystackRes.data.authorization_url,
      accessCode: paystackRes.data.access_code,
    };
  }

  /**
   * Starts a payment for one course's internship document (a flat USD fee,
   * INTERNSHIP_DOCUMENT_PRICE_USD, default $5). Same Paystack checkout and
   * callback as a token purchase, but finalizeTransaction credits no tokens
   * for it - the paid transaction itself is what unlocks the download.
   */
  async initializeInternshipDocument(userId: string, skillTutorialId: string, amountUsd: number, currencyInput?: string) {
    assertValidId(userId, 'User');
    const user = await this.users.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');

    const currency = (currencyInput || this.defaultCurrency()).toUpperCase();
    if (!this.exchangeRates.isSupported(currency)) {
      throw new BadRequestException(`Currency "${currency}" is not supported.`);
    }
    const amount = currency === 'USD' ? amountUsd : this.exchangeRates.toCurrency(amountUsd, currency);
    const reference = `int_${userId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const transaction = await this.transactions.save(this.transactions.create({
      userId,
      payerEmail: user.email,
      payerName: [user.firstName, user.lastName].filter(Boolean).join(' ') || null,
      reference,
      tokensRequested: 0,
      packageId: null,
      pricePerTokenUsd: this.tokens.pricing().pricePerTokenUsd,
      amountUsd,
      amount,
      currency,
      status: 'PENDING',
      purpose: 'INTERNSHIP_DOCUMENT',
      purposeRef: skillTutorialId,
    }));

    const paystackRes = await this.paystack.initializeTransaction({
      email: user.email,
      amount: Math.round(amount * 100),
      currency,
      reference,
      callback_url: this.config.get<string>('PAYMENT_CALLBACK_URL'),
      metadata: { userId, purpose: 'INTERNSHIP_DOCUMENT', skillTutorialId, transactionId: transaction.id },
    });

    return {
      reference,
      amount,
      amountUsd,
      currency,
      authorizationUrl: paystackRes.data.authorization_url,
      accessCode: paystackRes.data.access_code,
    };
  }

  /** The most recent successful internship-document payment this user made for this course, if any. */
  async findPaidInternshipDocument(userId: string, skillTutorialId: string) {
    assertValidId(userId, 'User');
    return this.transactions.findOne({
      where: { userId, purpose: 'INTERNSHIP_DOCUMENT', purposeRef: skillTutorialId, status: 'SUCCESS' },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * If the buyer closed the tab before the Paystack redirect, the webhook may
   * be the only thing that confirms the payment - and may be delayed. This lets
   * the document screen settle a still-PENDING payment on its own.
   */
  async settlePendingInternshipDocument(userId: string, skillTutorialId: string) {
    assertValidId(userId, 'User');
    const pending = await this.transactions.find({
      where: { userId, purpose: 'INTERNSHIP_DOCUMENT', purposeRef: skillTutorialId, status: 'PENDING' },
      order: { createdAt: 'DESC' },
      take: 3,
    });
    for (const tx of pending) {
      try {
        await this.finalizeTransaction(tx.reference);
      } catch (err) {
        this.logger.warn(`Could not settle ${tx.reference}: ${err}`);
      }
    }
  }

  /**
   * The single place tokens are actually awarded. Called from both the
   * Paystack webhook and the "verify on return" endpoint the frontend hits
   * after checkout - both re-verify directly against Paystack's API (never
   * trusting a client- or webhook-supplied status alone), and this is
   * idempotent, so whichever fires first wins and the other is a no-op.
   */
  async finalizeTransaction(reference: string) {
    const transaction = await this.transactions.findOneBy({ reference });
    if (!transaction) throw new NotFoundException('Transaction not found');

    if (transaction.status === 'SUCCESS') {
      return transaction; // already processed
    }

    const verifyRes = await this.paystack.verifyTransaction(reference);
    const paystackStatus = verifyRes.data.status;
    transaction.paystackData = verifyRes.data;

    if (paystackStatus === 'success') {
      const paidAmountMajor = verifyRes.data.amount / 100;
      const paidCurrency = verifyRes.data.currency;

      // What Paystack confirms must match what we asked for. If it doesn't,
      // something is wrong (tampering, a stale/reused reference, a Paystack
      // config mismatch) - don't award tokens.
      const amountMatches = Math.abs(paidAmountMajor - transaction.amount) < 0.01;
      if (paidCurrency !== transaction.currency || !amountMatches) {
        transaction.status = 'FAILED';
        await this.transactions.save(transaction);
        this.logger.warn(
          `Transaction ${reference} verification mismatch: expected ${transaction.amount} ${transaction.currency}, got ${paidAmountMajor} ${paidCurrency}`,
        );
        throw new BadRequestException('Payment verification mismatch');
      }

      // An internship-document payment credits nothing - the SUCCESS row itself unlocks the download.
      if (transaction.purpose === 'INTERNSHIP_DOCUMENT') {
        transaction.status = 'SUCCESS';
        await this.transactions.save(transaction);
        this.logger.log(`Internship document paid by user ${transaction.userId} for ${transaction.purposeRef} (${reference})`);
        return transaction;
      }

      // Credit first, mark SUCCESS second: if crediting throws, the row stays
      // PENDING and the next webhook retry (or a manual verify) tries again,
      // rather than being permanently skipped by the idempotency check above.
      const { balanceAfter } = await this.tokens.credit(String(transaction.userId), transaction.tokensRequested, {
        entryType: 'PURCHASE',
        label: transaction.packageId ?? 'custom',
        reference: transaction.reference,
      });

      transaction.status = 'SUCCESS';
      transaction.tokensAwarded = transaction.tokensRequested;
      await this.transactions.save(transaction);

      this.logger.log(
        `Credited ${transaction.tokensRequested} tokens to user ${transaction.userId} (${reference}); new balance ${balanceAfter}`,
      );
    } else {
      transaction.status = paystackStatus === 'abandoned' ? 'ABANDONED' : 'FAILED';
      await this.transactions.save(transaction);
    }

    return transaction;
  }

  /** Handles the raw Paystack webhook POST. */
  async handleWebhook(rawBody: Buffer, signature: string | undefined) {
    if (!this.paystack.verifySignature(rawBody, signature)) {
      throw new BadRequestException('Invalid Paystack signature');
    }

    const event = JSON.parse(rawBody.toString('utf8'));

    if (event.event === 'charge.success' && event.data?.reference) {
      try {
        await this.finalizeTransaction(event.data.reference);
      } catch (err) {
        // Log and swallow - Paystack retries webhooks on non-2xx, and a
        // failed verification/mismatch is already recorded on the
        // transaction itself by finalizeTransaction.
        this.logger.error(`Webhook finalize failed for ${event.data.reference}: ${err}`);
      }
    }

    return { received: true };
  }

  async getBalance(userId: string) {
    const tokens = await this.tokens.getBalance(userId);
    const { pricePerTokenUsd } = this.tokens.pricing();
    return { tokens, pricePerTokenUsd };
  }

  async getHistory(userId: string) {
    assertValidId(userId, 'User');
    return this.transactions.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }
}
