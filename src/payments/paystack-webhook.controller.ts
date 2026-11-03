import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { PaymentsService } from './payments.service';

/**
 * Separate, unguarded controller for Paystack's server-to-server webhook -
 * intentionally has no JwtAuthGuard, since Paystack calls this directly and
 * can't send a user JWT. Authenticity is instead verified via the
 * x-paystack-signature HMAC header inside PaymentsService.handleWebhook.
 *
 * Requires `rawBody: true` to be passed to NestFactory.create() in main.ts -
 * signature verification needs the exact raw bytes Paystack signed, not the
 * re-serialized parsed JSON body.
 */
@Controller('webhooks/paystack')
export class PaystackWebhookController {
  constructor(private paymentsService: PaymentsService) {}

  @Post()
  @HttpCode(200)
  handle(@Req() req: RawBodyRequest<Request>, @Headers('x-paystack-signature') signature: string) {
    return this.paymentsService.handleWebhook(req.rawBody as Buffer, signature);
  }
}
