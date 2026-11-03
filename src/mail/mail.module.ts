import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Global so any service (AuthService, etc.) can inject MailService without
 * importing this module directly - same pattern as StorageModule.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
