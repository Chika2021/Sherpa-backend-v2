import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CredentialsService } from './credentials.service';
import { CreateSiteCredentialDto } from './dto/create-site-credential.dto';

// Note: nothing here ever returns a decrypted (or even encrypted) password -
// see CredentialsService.toSafeJSON. Passwords only ever flow: client -> this
// controller (over HTTPS, in-request-body only) -> encrypted at rest -> later
// decrypted in-memory by CredentialsService.findForDomain for a single
// auto-apply attempt.
@UseGuards(JwtAuthGuard)
@Controller('credentials')
export class CredentialsController {
  constructor(private credentialsService: CredentialsService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.credentialsService.listForUser(userId);
  }

  // Also used to update an existing credential for a domain (upsert on
  // userId + domain).
  @Post()
  upsert(@CurrentUser('id') userId: string, @Body() dto: CreateSiteCredentialDto) {
    return this.credentialsService.upsert(userId, dto);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.credentialsService.remove(userId, id);
  }
}
