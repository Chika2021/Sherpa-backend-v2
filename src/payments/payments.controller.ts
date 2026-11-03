import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { InitializePaymentDto } from './dto/initialize-payment.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private paymentsService: PaymentsService) {}

  // Public: lets the frontend know the Paystack public key, default/supported
  // currencies, the base price per token, and the discounted bundle packages
  // (cheaper price options) before showing the buy screen.
  @Get('config')
  getConfig() {
    return this.paymentsService.getPublicConfig();
  }

  @UseGuards(JwtAuthGuard)
  @Post('initialize')
  initialize(@CurrentUser('id') userId: string, @Body() dto: InitializePaymentDto) {
    return this.paymentsService.initialize(userId, dto);
  }

  // The frontend calls this right after Paystack redirects back to
  // PAYMENT_CALLBACK_URL, to get instant confirmation instead of waiting on
  // the webhook. Safe to call more than once - finalizeTransaction is idempotent.
  @UseGuards(JwtAuthGuard)
  @Get('verify/:reference')
  verify(@Param('reference') reference: string) {
    return this.paymentsService.finalizeTransaction(reference);
  }

  @UseGuards(JwtAuthGuard)
  @Get('balance')
  balance(@CurrentUser('id') userId: string) {
    return this.paymentsService.getBalance(userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('history')
  history(@CurrentUser('id') userId: string) {
    return this.paymentsService.getHistory(userId);
  }
}
