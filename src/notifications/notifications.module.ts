import { Global, Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/** Global so payments, support, referrals, auth and monitoring can all call NotificationsService.notify without importing this module. */
@Global()
@Module({
  imports: [EntitiesModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
