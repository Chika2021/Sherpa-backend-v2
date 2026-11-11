import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { EmailApplyService } from './email-apply.service';
import {
  CreateEmailApplicationDto,
  RegenerateEmailDto,
  SendEmailApplicationDto,
  UpdateEmailApplicationDto,
} from './dto/email-apply.dto';

/**
 * Apply by email. The `:id` in every route is the APPLICATION id (the same id the Applications list shows).
 *
 *   1. POST  /applications/email                          job title + description + requirements [+ recipientEmail]
 *                                                          -> application with tailored resume, cover letter and the email draft
 *      GET   /applications/email/:id                       the same view again (also says whether the server can send mail)
 *   2. PATCH /applications/email/:id                       edit recipient / subject / body
 *      POST  /applications/email/:id/regenerate-email      rewrite just the email  { instructions? }
 *      POST  /applications/email/:id/regenerate-documents  rewrite the resume + cover letter
 *   3. POST  /applications/email/:id/send                  send it (documents attached) and register it as applied
 *
 * Deleting is the normal DELETE /applications/:id. Nothing is ever sent without step 3.
 */
@UseGuards(JwtAuthGuard)
@Controller('applications/email')
export class EmailApplyController {
  constructor(private emailApply: EmailApplyService) {}

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateEmailApplicationDto) {
    return this.emailApply.createDraft(userId, dto);
  }

  @Get(':id')
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.emailApply.view(userId, id);
  }

  @Patch(':id')
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateEmailApplicationDto) {
    return this.emailApply.update(userId, id, dto);
  }

  @Post(':id/regenerate-email')
  regenerateEmail(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: RegenerateEmailDto) {
    return this.emailApply.regenerateEmail(userId, id, dto);
  }

  @Post(':id/regenerate-documents')
  regenerateDocuments(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.emailApply.regenerateDocuments(userId, id);
  }

  @Post(':id/send')
  send(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: SendEmailApplicationDto) {
    return this.emailApply.send(userId, id, dto);
  }
}
