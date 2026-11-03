import { Module } from '@nestjs/common';
import { ResumeBuilderService } from './resume-builder.service';
import { ResumeBuilderController } from './resume-builder.controller';
import { ResumePdfService } from './resume-pdf.service';
import { AiModule } from '../ai/ai.module';
import { ResumesModule } from '../resumes/resumes.module';
import { EntitiesModule } from '../entities/entities.module';

@Module({
  imports: [AiModule, ResumesModule, EntitiesModule],
  providers: [ResumeBuilderService, ResumePdfService],
  controllers: [ResumeBuilderController],
  exports: [ResumeBuilderService],
})
export class ResumeBuilderModule {}
