import { Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { PaymentsModule } from '../payments/payments.module';
import { ConsultationsController } from './consultations.controller';
import { ConsultationsService } from './consultations.service';

/** Buy and sell virtual consultations. Students pay through PaymentsModule (Paystack). TokensService and NotificationsService come from their Global modules. */
@Module({
  imports: [EntitiesModule, PaymentsModule],
  controllers: [ConsultationsController],
  providers: [ConsultationsService],
  exports: [ConsultationsService],
})
export class ConsultationsModule {}
