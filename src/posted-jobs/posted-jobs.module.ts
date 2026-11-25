import { Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { PostedJobsController } from './posted-jobs.controller';
import { PostedJobsService } from './posted-jobs.service';

/** Member-posted jobs with automatic expiry. NotificationsService is global, so it is not imported here. */
@Module({
  imports: [EntitiesModule],
  controllers: [PostedJobsController],
  providers: [PostedJobsService],
  exports: [PostedJobsService],
})
export class PostedJobsModule {}
