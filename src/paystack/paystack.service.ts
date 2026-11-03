import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

export interface PaystackInitializePayload {
  email: string;
  amount: number; // integer, smallest currency unit (cents/kobo)
  currency: string;
  reference: string;
  callback_url?: string;
  metadata?: Record<string, any>;
}

export interface PaystackInitializeResponse {
  status: boolean;
  message: string;
  data: { authorization_url: string; access_code: string; reference: string };
}

export interface PaystackVerifyResponse {
  status: boolean;
  message: string;
  data: {
    status: 'success' | 'failed' | 'abandoned' | string;
    reference: string;
    amount: number; // smallest currency unit
    currency: string;
    paid_at?: string;
    channel?: string;
    customer?: Record<string, any>;
    [key: string]: any;
  };
}

/**
 * Thin wrapper around Paystack's REST API (https://paystack.com/docs/api/).
 * Uses the global `fetch` (Node 18+) - no extra HTTP client dependency.
 */
@Injectable()
export class PaystackService {
  private readonly logger = new Logger(PaystackService.name);
  private readonly baseUrl: string;
  private readonly secretKey: string;

  constructor(private config: ConfigService) {
    this.secretKey = this.config.get<string>('PAYSTACK_SECRET_KEY') || '';
    this.baseUrl = this.config.get<string>('PAYSTACK_BASE_URL') || 'https://api.paystack.co';

    if (!this.secretKey) {
      this.logger.warn(
        'PAYSTACK_SECRET_KEY is not set - payment initialization/verification will fail until it is configured.',
      );
    }
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.secretKey}`,
      'Content-Type': 'application/json',
    };
  }

  async initializeTransaction(payload: PaystackInitializePayload): Promise<PaystackInitializeResponse> {
    const res = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok || !data.status) {
      this.logger.error(`Paystack initialize failed: ${res.status} ${JSON.stringify(data)}`);
      throw new BadGatewayException(data.message || 'Failed to initialize payment with Paystack');
    }
    return data;
  }

  async verifyTransaction(reference: string): Promise<PaystackVerifyResponse> {
    const res = await fetch(`${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
      headers: this.headers(),
    });

    const data = await res.json();
    if (!res.ok || !data.status) {
      this.logger.error(`Paystack verify failed: ${res.status} ${JSON.stringify(data)}`);
      throw new BadGatewayException(data.message || 'Failed to verify payment with Paystack');
    }
    return data;
  }

  /**
   * Validates the `x-paystack-signature` header against the raw request body,
   * per https://paystack.com/docs/payments/webhooks/#verifying-events -
   * required so nothing except Paystack itself can trigger a webhook-driven
   * token top-up.
   */
  verifySignature(rawBody: Buffer, signature: string | undefined): boolean {
    if (!signature || !this.secretKey) return false;
    const hash = crypto.createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    return hash === signature;
  }
}
