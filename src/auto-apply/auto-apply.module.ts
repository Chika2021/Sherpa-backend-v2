import { Module } from '@nestjs/common';
import { AutoApplyService } from './auto-apply.service';
import { AutoApplyController } from './auto-apply.controller';
import { EntitiesModule } from '../entities/entities.module';

/**
 * Auto Apply now runs in the user's browser (the frontend + the Sherpa Auto Apply extension), NOT on this server.
 * This module only keeps the history of past batches readable (list / get / cancel); nothing here searches for jobs,
 * fills in forms or applies on its own, and nothing runs at start-up.
 */
@Module({
  imports: [EntitiesModule],
  providers: [AutoApplyService],
  controllers: [AutoApplyController],
})
export class AutoApplyModule {}
