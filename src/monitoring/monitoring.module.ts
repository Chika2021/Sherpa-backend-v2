import { Global, Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { MonitoringService } from './monitoring.service';
import { MonitoringController } from './monitoring.controller';

// MailService, RealtimeService and NotificationsService come from their Global modules.
/** Global so auth, tokens, payments and referrals can report events without importing this module. */
@Global()
@Module({
  imports: [EntitiesModule],
  controllers: [MonitoringController],
  providers: [MonitoringService],
  exports: [MonitoringService],
})
export class MonitoringModule {}
