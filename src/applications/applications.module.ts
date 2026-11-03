import { Module } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { ApplicationsController } from './applications.controller';
import { ResumesModule } from '../resumes/resumes.module';
import { DocumentsModule } from '../documents/documents.module';
import { CredentialsModule } from '../credentials/credentials.module';
import { GenericFormAdapter } from './adapters/generic-form.adapter';
import { SubmitterRegistry } from './adapters/submitter-registry.service';
import { EntitiesModule } from '../entities/entities.module';
import { AiModule } from '../ai/ai.module';
import { AssistedApplyService } from './assisted/assisted-apply.service';
import { AssistedApplyController } from './assisted/assisted-apply.controller';

@Module({
  imports: [ResumesModule, DocumentsModule, CredentialsModule, EntitiesModule, AiModule],
  providers: [ApplicationsService, GenericFormAdapter, SubmitterRegistry, AssistedApplyService],
  controllers: [ApplicationsController, AssistedApplyController],
  exports: [ApplicationsService, SubmitterRegistry],
})
export class ApplicationsModule {}
