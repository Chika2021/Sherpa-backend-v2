import { Global, Module } from '@nestjs/common';
import { TokensService } from './tokens.service';
import { TokensController } from './tokens.controller';
import { EntitiesModule } from '../entities/entities.module';

/**
 * Global (like MailModule/StorageModule) so any feature - payments now,
 * job applications later if you want applying to cost tokens - can inject
 * TokensService without importing this module directly.
 */
@Global()
@Module({
  imports: [EntitiesModule],
  controllers: [TokensController],
  providers: [TokensService],
  exports: [TokensService],
})
export class TokensModule {}
