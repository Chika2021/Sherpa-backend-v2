import { Module } from '@nestjs/common';
import { InterviewPrepService } from './interview-prep.service';
import { InterviewPrepController } from './interview-prep.controller';
import { LiveInterviewService } from './live-interview.service';
import { LiveInterviewController } from './live-interview.controller';
import { AiModule } from '../ai/ai.module';
import { EntitiesModule } from '../entities/entities.module';
import { AudioModule } from '../audio/audio.module';

@Module({
  imports: [AiModule, EntitiesModule, AudioModule],
  providers: [InterviewPrepService, LiveInterviewService],
  controllers: [InterviewPrepController, LiveInterviewController],
  exports: [InterviewPrepService, LiveInterviewService],
})
export class InterviewPrepModule {}
