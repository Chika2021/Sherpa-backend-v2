import { Body, Controller, Delete, Get, Param, Post, Res, StreamableFile, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AssistedApplyService } from './assisted-apply.service';
import { AnswerFieldsDto } from './dto/answer-fields.dto';
import { PrepareFromLinkDto } from './dto/prepare-from-link.dto';
import { SubmitAssistedDto } from './dto/submit-assisted.dto';

/**
 * "Fill it for me, I'll press Submit" flow for jobs the AI found:
 *
 *   1. POST   /assisted-apply/prepare      { jobId?, applyUrl }  -> session (status PREPARING)
 *   2. GET    /assisted-apply/:id          poll until READY_FOR_REVIEW (or NEEDS_MANUAL / FAILED)
 *      GET    /assisted-apply/:id/screenshot   what the filled form looks like
 *   3. POST   /assisted-apply/:id/answers  { answers: [{ fieldId, value }] }  optional - fill what's left
 *   4. POST   /assisted-apply/:id/submit   the user's click - the only thing that submits
 *      DELETE /assisted-apply/:id          walk away
 */
@UseGuards(JwtAuthGuard)
@Controller('assisted-apply')
export class AssistedApplyController {
  constructor(private assisted: AssistedApplyService) {}

  @Post('prepare')
  prepare(@CurrentUser('id') userId: string, @Body() dto: PrepareFromLinkDto) {
    return this.assisted.prepare(userId, dto);
  }

  // Declared before ':id' so "active" isn't treated as a session id.
  @Get('active')
  active(@CurrentUser('id') userId: string) {
    return this.assisted.getActive(userId);
  }

  @Get(':id')
  getOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.assisted.getView(userId, id);
  }

  @Get(':id/screenshot')
  screenshot(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const image = this.assisted.getScreenshot(userId, id);
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
    return new StreamableFile(image);
  }

  @Post(':id/answers')
  answers(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AnswerFieldsDto) {
    return this.assisted.answer(userId, id, dto);
  }

  @Post(':id/submit')
  submit(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: SubmitAssistedDto) {
    return this.assisted.submit(userId, id, dto);
  }

  @Delete(':id')
  cancel(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.assisted.cancel(userId, id);
  }
}
