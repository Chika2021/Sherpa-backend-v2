import { Module } from '@nestjs/common';
import { AudioService } from './audio.service';
import { AiModule } from '../ai/ai.module';
import { EntitiesModule } from '../entities/entities.module';

@Module({
  imports: [AiModule, EntitiesModule],
  providers: [AudioService],
  exports: [AudioService],
})
export class AudioModule {}
