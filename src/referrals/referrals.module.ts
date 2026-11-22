import { Global, Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { ReferralsService } from './referrals.service';
import { ReferralsAdminController, ReferralsController } from './referrals.controller';

// TokensService, NotificationsService and MonitoringService come from their Global modules.
/** Global so AuthService (sign-up, email verification) and PaymentsService (first purchase) can use ReferralsService. */
@Global()
@Module({
  imports: [EntitiesModule],
  controllers: [ReferralsController, ReferralsAdminController],
  providers: [ReferralsService],
  exports: [ReferralsService],
})
export class ReferralsModule {}
