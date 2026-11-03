import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WorkshopService } from './workshop.service';
import { InternshipDocumentService } from './internship-document.service';
import { ApplyInternshipDocumentDto, AskWorkshopMentorDto, CreateWorkshopDto, SubmitWorkshopStepDto } from './dto/workshop.dto';

/**
 * AI Workshop on the skill details page: internship-style practical training.
 * Everything hangs off a skill course (`:id`). Unit ids are "L1".."L4" for the
 * practical levels and "P1".."P3" for the real-world projects.
 */
@UseGuards(JwtAuthGuard)
@Controller('skills/:id/workshop')
export class WorkshopController {
  constructor(
    private workshop: WorkshopService,
    private documents: InternshipDocumentService,
  ) {}

  // Home screen. { created: false } until the workshop has been created.
  @Get()
  overview(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.workshop.getOverview(userId, id);
  }

  // Designs the workshop (all levels + projects). 1 token; returns the existing one for free unless { restart: true }.
  @Post()
  create(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: CreateWorkshopDto) {
    return this.workshop.create(userId, id, !!dto.restart);
  }

  // One level/project with its steps and your progress on each.
  @Get('units/:unitId')
  unit(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('unitId') unitId: string) {
    return this.workshop.getUnit(userId, id, unitId);
  }

  // Starts it: the AI writes the full step-by-step guide. 1 token the first time, free after.
  @Post('units/:unitId/start')
  start(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('unitId') unitId: string) {
    return this.workshop.startUnit(userId, id, unitId);
  }

  // Hand in a step's checkpoint (code / output / explanation) for real-time review. 1 token per review.
  @Post('units/:unitId/steps/:stepIndex/submit')
  submit(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Param('stepIndex', ParseIntPipe) stepIndex: number,
    @Body() dto: SubmitWorkshopStepDto,
  ) {
    return this.workshop.submitStep(userId, id, unitId, stepIndex, dto.submission);
  }

  // Chat with the AI supervisor about a step.
  @Get('units/:unitId/steps/:stepIndex/mentor')
  mentorChat(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Param('stepIndex', ParseIntPipe) stepIndex: number,
  ) {
    return this.workshop.getMentorChat(userId, id, unitId, stepIndex);
  }

  @Post('units/:unitId/steps/:stepIndex/mentor')
  askMentor(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Param('stepIndex', ParseIntPipe) stepIndex: number,
    @Body() dto: AskWorkshopMentorDto,
  ) {
    return this.workshop.askMentor(userId, id, unitId, stepIndex, dto.question);
  }

  @Delete('units/:unitId/steps/:stepIndex/mentor')
  clearMentorChat(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('unitId') unitId: string,
    @Param('stepIndex', ParseIntPipe) stepIndex: number,
  ) {
    return this.workshop.clearMentorChat(userId, id, unitId, stepIndex);
  }

  // ---- Lora's voice ----
  // What Lora says (text, for captions) and her synthesized voice (audio/wav) for the same moment.
  // kind = intro | unit | step | feedback | mentor | finish - see WorkshopService.loraText. Costs no token.
  @Get('lora/script')
  loraScript(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('kind') kind: string,
    @Query('unitId') unitId?: string,
    @Query('stepIndex') stepIndex?: string,
    @Query('createdAt') createdAt?: string,
  ) {
    return this.workshop
      .loraText(userId, id, { kind, unitId, stepIndex: stepIndex === undefined ? undefined : Number(stepIndex), createdAt: createdAt ? new Date(createdAt).getTime() : undefined })
      .then((r) => ({ text: r.text }));
  }

  @Get('lora/audio')
  async loraAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('kind') kind: string,
    @Query('voice') voice: string | undefined,
    @Query('unitId') unitId: string | undefined,
    @Query('stepIndex') stepIndex: string | undefined,
    @Query('createdAt') createdAt: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.workshop.serveLoraAudio(
      req,
      res,
      userId,
      id,
      { kind, unitId, stepIndex: stepIndex === undefined ? undefined : Number(stepIndex), createdAt: createdAt ? new Date(createdAt).getTime() : undefined },
      voice,
    );
  }

  // ---- Internship document (after finishing the internship; paid) ----
  @Get('document')
  documentStatus(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.documents.status(userId, id);
  }

  // Apply = start the payment. Returns a Paystack authorizationUrl to send the learner to.
  @Post('document/apply')
  documentApply(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: ApplyInternshipDocumentDto) {
    return this.documents.apply(userId, id, dto.currency);
  }

  // The generated PDF. 403 until the internship is finished and the fee is paid.
  @Get('document/download')
  async documentDownload(@CurrentUser('id') userId: string, @Param('id') id: string, @Res() res: Response) {
    const { buffer, filename } = await this.documents.download(userId, id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
      'Cache-Control': 'private, no-store',
    });
    res.end(buffer);
  }
}
