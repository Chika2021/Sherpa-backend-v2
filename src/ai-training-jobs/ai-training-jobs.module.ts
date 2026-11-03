import { Module } from '@nestjs/common';
import { AiTrainingJobsController } from './ai-training-jobs.controller';
import { AiTrainingJobsService } from './ai-training-jobs.service';
import { SavedAiTrainingJobsService } from './saved-ai-training-jobs.service';
import { EntitiesModule } from '../entities/entities.module';
import { AtsBoardProvider } from './ats-board.provider';
import { ApifyJobSourceProvider } from './apify.provider';
import { RemotiveJobSourceProvider } from '../jobs/providers/remotive.provider';
import { RemoteOkJobSourceProvider } from '../jobs/providers/remoteok.provider';
import { ArbeitnowJobSourceProvider } from '../jobs/providers/arbeitnow.provider';
import { JobicyJobSourceProvider } from '../jobs/providers/jobicy.provider';

// These four providers have no constructor dependencies, so this module
// instantiates its own copies rather than touching JobsModule.
@Module({
  imports: [EntitiesModule],
  providers: [
    AiTrainingJobsService,
    SavedAiTrainingJobsService,
    AtsBoardProvider,
    ApifyJobSourceProvider,
    RemotiveJobSourceProvider,
    RemoteOkJobSourceProvider,
    ArbeitnowJobSourceProvider,
    JobicyJobSourceProvider,
  ],
  controllers: [AiTrainingJobsController],
  exports: [AiTrainingJobsService, SavedAiTrainingJobsService],
})
export class AiTrainingJobsModule {}
