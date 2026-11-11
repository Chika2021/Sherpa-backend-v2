import { Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { SupportService } from './support.service';
import { SupportAdminController, SupportPublicController, SupportUserController } from './support.controller';

@Module({
  imports: [EntitiesModule],
  providers: [SupportService],
  controllers: [SupportPublicController, SupportUserController, SupportAdminController],
  exports: [SupportService],
})
export class SupportModule {}
