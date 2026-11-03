import { Module } from '@nestjs/common';
import { DocumentsService } from './documents.service';
import { AiModule } from '../ai/ai.module';
import { EntitiesModule } from '../entities/entities.module';

@Module({
  imports: [AiModule, EntitiesModule],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}

//THIS IS THE DOCUMENT MODULE, IT IS RESPONSIBLE FOR HANDLING DOCUMENTS IN THE APPLICATION. IT IMPORTS THE AI MODULE AND ENTITIES MODULE, PROVIDES THE DOCUMENTS SERVICE, AND EXPORTS IT FOR USE IN OTHER PARTS OF THE APPLICATION.