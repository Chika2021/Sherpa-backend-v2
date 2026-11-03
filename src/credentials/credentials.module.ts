import { Module } from '@nestjs/common';
import { EntitiesModule } from '../entities/entities.module';
import { EncryptionService } from '../common/crypto/encryption.service';
import { CredentialsService } from './credentials.service';
import { CredentialsController } from './credentials.controller';

@Module({
  imports: [EntitiesModule],
  controllers: [CredentialsController],
  providers: [CredentialsService, EncryptionService],
  exports: [CredentialsService],
})
export class CredentialsModule {}
