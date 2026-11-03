import { Module } from '@nestjs/common';
import { SkillsService } from './skills.service';
import { SkillsController } from './skills.controller';
import { SkillTutorialPdfService } from './skill-tutorial-pdf.service';
import { SkillVideosService } from './skill-videos.service';
import { WorkshopService } from './workshop.service';
import { WorkshopController } from './workshop.controller';
import { InternshipDocumentService } from './internship-document.service';
import { InternshipDocumentPdfService } from './internship-document-pdf.service';
import { PaymentsModule } from '../payments/payments.module';
import { AiModule } from '../ai/ai.module';
import { EntitiesModule } from '../entities/entities.module';
import { AudioModule } from '../audio/audio.module';

@Module({
  imports: [AiModule, EntitiesModule, AudioModule, PaymentsModule],
  providers: [SkillsService, SkillTutorialPdfService, SkillVideosService, WorkshopService, InternshipDocumentService, InternshipDocumentPdfService],
  controllers: [SkillsController, WorkshopController],
  exports: [SkillsService],
})
export class SkillsModule {}
