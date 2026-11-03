import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { ResumesService } from './resumes.service';
import { ResumesController } from './resumes.controller';
import { ResumeParserService } from './resume-parser.service';
import { AiModule } from '../ai/ai.module';
import { EntitiesModule } from '../entities/entities.module';

@Module({
  imports: [MulterModule.register({}), AiModule, EntitiesModule],
  providers: [ResumesService, ResumeParserService],
  controllers: [ResumesController],
  exports: [ResumesService],
})
export class ResumesModule {}
