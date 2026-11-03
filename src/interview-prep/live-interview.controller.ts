import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LiveInterviewService } from './live-interview.service';
import { StartLiveInterviewDto } from './dto/start-live-interview.dto';
import { ReplyLiveInterviewDto } from './dto/reply-live-interview.dto';

/**
 * Live Interview with Lora - lives under /interview-prep/:id/live-interview.
 * Flow: GET (list attempts) -> POST start -> loop { GET .../audio to hear Lora,
 * POST .../reply with the candidate's answer } until Lora closes (or POST .../end).
 */
@UseGuards(JwtAuthGuard)
@Controller('interview-prep')
export class LiveInterviewController {
  constructor(private liveInterview: LiveInterviewService) {}

  // Past attempts for this prep + the id of the one in progress (so the UI can offer "resume").
  @Get(':id/live-interview')
  list(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.liveInterview.list(userId, id);
  }

  // Starts (or resumes) an interview. Body: { voice?, questionCount?, restart? }.
  // Costs 1 token, charged once; everything after that is free.
  @Post(':id/live-interview/start')
  start(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: StartLiveInterviewDto) {
    return this.liveInterview.start(userId, id, dto);
  }

  // Full state of one attempt: transcript, progress, and (once finished) the report.
  @Get(':id/live-interview/:sessionId')
  get(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('sessionId') sessionId: string) {
    return this.liveInterview.get(userId, id, sessionId);
  }

  // The candidate's answer - multipart field "audio" (a recording) OR form field "answer" (typed text).
  // Returns Lora's reply (follow-up / next question / closing).
  @Post(':id/live-interview/:sessionId/reply')
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(), // held in memory only long enough to send to Gemini - never written to disk
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype)),
    }),
  )
  reply(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() dto: ReplyLiveInterviewDto,
    @UploadedFile() audio: Express.Multer.File,
  ) {
    return this.liveInterview.reply(userId, id, sessionId, dto, audio);
  }

  // Ends the interview early and returns the report (also regenerates a missing report).
  @Post(':id/live-interview/:sessionId/end')
  end(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('sessionId') sessionId: string) {
    return this.liveInterview.end(userId, id, sessionId);
  }

  @Delete(':id/live-interview/:sessionId')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('sessionId') sessionId: string) {
    return this.liveInterview.remove(userId, id, sessionId);
  }

  // Lora's real synthesized voice (audio/wav) for one of her turns. ?turnIndex= comes from the
  // `interviewer.turnIndex` of a reply (or `turns[].turnIndex` of the state). ?voice= optionally
  // overrides the voice chosen at start.
  @Get(':id/live-interview/:sessionId/audio')
  async turnAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Query('turnIndex') turnIndex: string,
    @Query('voice') voice: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.liveInterview.getTurnAudio(req, res, userId, id, sessionId, Number(turnIndex), voice);
  }
}
