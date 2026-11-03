import { Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { JobSourceSettingsService } from './job-source-settings.service';
import { JobSourceSettingsController } from './job-source-settings.controller';

@Module({
  imports: [EntitiesModule],
  providers: [JobSourceSettingsService],
  controllers: [JobSourceSettingsController],
  // Exported so JobsModule can inject JobSourceSettingsService into JobsService.
  exports: [JobSourceSettingsService],
})
export class JobSourceSettingsModule {}
