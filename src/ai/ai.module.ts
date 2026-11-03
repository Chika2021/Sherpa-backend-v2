import { Module } from '@nestjs/common';
import { GeminiService } from './gemini.service';
import { CerebrasService } from './cerebras.service';
import { AiController } from './ai.controller';

@Module({
  controllers: [AiController],
  providers: [GeminiService, CerebrasService],
  exports: [GeminiService, CerebrasService],
})
export class AiModule {}
