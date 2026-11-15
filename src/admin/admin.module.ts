import { Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { AiModule } from '../ai/ai.module';
import { AdminController } from './admin.controller';
import { CountdownController } from './countdown.controller';
import { AdminService } from './admin.service';
import { ActivityService } from './activity.service';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AppInfoService } from './app-info.service';
import { LocalJobBoardsController } from './local-job-boards.controller';
import { LocalJobBoardsService } from './local-job-boards.service';

// TokensService, MailService and RealtimeService come from their Global modules.
@Module({
  imports: [EntitiesModule, AiModule],
  controllers: [AdminController, CountdownController, LocalJobBoardsController],
  providers: [AdminService, ActivityService, AppInfoService, AdminBootstrapService, LocalJobBoardsService],
  exports: [AdminService],
})
export class AdminModule {}
