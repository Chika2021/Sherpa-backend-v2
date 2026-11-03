import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { AiModule } from '../ai/ai.module';
import { ResumesModule } from '../resumes/resumes.module';
import { EntitiesModule } from '../entities/entities.module';
import { JobSourceSettingsModule } from '../job-sources/job-source-settings.module';
import { RemotiveJobSourceProvider } from './providers/remotive.provider';
import { RemoteOkJobSourceProvider } from './providers/remoteok.provider';
import { ArbeitnowJobSourceProvider } from './providers/arbeitnow.provider';
import { JobicyJobSourceProvider } from './providers/jobicy.provider';
import { AdzunaJobSourceProvider } from './providers/adzuna.provider';
import { WeAreDevelopersJobSourceProvider } from './providers/wearedevelopers.provider';
import { ContraJobSourceProvider } from './providers/contra.provider';

@Module({
  imports: [AiModule, ResumesModule, EntitiesModule, JobSourceSettingsModule],
  providers: [
    JobsService,
    RemotiveJobSourceProvider,
    RemoteOkJobSourceProvider,
    ArbeitnowJobSourceProvider,
    JobicyJobSourceProvider,
    AdzunaJobSourceProvider,
    WeAreDevelopersJobSourceProvider,
    ContraJobSourceProvider,
  ],
  controllers: [JobsController],
  exports: [JobsService],
})
export class JobsModule {}
