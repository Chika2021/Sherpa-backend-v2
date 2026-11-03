import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { KeepAwakeService } from './keep-awake.service';

@Module({
  controllers: [HealthController],
  providers: [KeepAwakeService],
})
export class HealthModule {}
