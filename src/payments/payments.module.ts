import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PaystackWebhookController } from './paystack-webhook.controller';
import { ExchangeRateService } from './exchange-rate.service';
import { PaystackModule } from '../paystack/paystack.module';
import { EntitiesModule } from '../entities/entities.module';
// TokensService comes from the Global TokensModule - no need to import it here.

@Module({
  imports: [EntitiesModule, PaystackModule],
  providers: [PaymentsService, ExchangeRateService],
  controllers: [PaymentsController, PaystackWebhookController],
  exports: [PaymentsService],
})
export class PaymentsModule {}
