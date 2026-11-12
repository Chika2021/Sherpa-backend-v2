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
import { InterviewPrepService } from './interview-prep.service';
import { CreateInterviewPrepDto } from './dto/create-interview-prep.dto';
import { PrepFromApplicationDto } from './dto/prep-from-application.dto';
import { AnswerCbtQuestionDto } from './dto/answer-cbt-question.dto';
import { SubmitVoiceAnswerDto } from './dto/submit-voice-answer.dto';
import { AskAiDto } from '../common/dto/ask-ai.dto';

@UseGuards(JwtAuthGuard)
@Controller('interview-prep')
export class InterviewPrepController {
  constructor(private interviewPrepService: InterviewPrepService) {}

  // The voices the interviewer can ask questions in. Declared before ':id'
  // below so "voices" isn't swallowed as an :id param.
  @Get('voices')
  getAvailableVoices() {
    return this.interviewPrepService.getAvailableVoices();
  }

  // "Prep for interview" button on an applied job (Applications page). Uses the
  // job info already saved with the application - no body needed. Returns the
  // prep (open it at the Interview Prep page by its id); reuses an existing
  // prep for the same job unless { regenerate: true } is sent.
  // Body (all optional): { count?, regenerate? }
  @Post('from-application/:applicationId')
  createFromApplication(
    @CurrentUser('id') userId: string,
    @Param('applicationId') applicationId: string,
    @Body() dto: PrepFromApplicationDto,
  ) {
    return this.interviewPrepService.createFromApplication(userId, applicationId, dto);
  }

  // Generates interview questions + model answers for a job.
  // Body: { jobTitle, jobDescription, jobRequirements?, count? }
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateInterviewPrepDto) {
    return this.interviewPrepService.create(userId, dto);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.interviewPrepService.findAllForUser(userId);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.findOne(userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.remove(userId, id);
  }

  // Generates (or regenerates) the multiple-choice practice quiz ("CBT")
  // from this session's questions, resetting any prior progress.
  @Post(':id/cbt')
  generateCbt(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.generateCbt(userId, id);
  }

  // Current quiz state - answers/explanations withheld for unanswered
  // questions so this can be safely polled while taking the quiz.
  @Get(':id/cbt')
  getCbt(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.getCbt(userId, id);
  }

  // Grades one answer and returns whether it was correct plus the
  // correction (correctOptionIndex + explanation) to show before advancing.
  @Post(':id/cbt/answer')
  answerCbt(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AnswerCbtQuestionDto) {
    return this.interviewPrepService.answerCbtQuestion(userId, id, dto);
  }

  @Post(':id/cbt/restart')
  restartCbt(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.restartCbt(userId, id);
  }

  // Real synthesized speech reading the CBT question aloud. ?voice= picks
  // one of GET /interview-prep/voices. Cached per (question, voice).
  @Get(':id/cbt/question-audio')
  async getCbtQuestionAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('questionIndex') questionIndex: string,
    @Query('voice') voice: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.interviewPrepService.getCbtQuestionAudio(req, res, userId, id, Number(questionIndex), voice);
  }

  // Real synthesized speech reading the correct answer + explanation aloud -
  // only available once that question has been answered (see service).
  @Get(':id/cbt/answer-audio')
  async getCbtAnswerAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('questionIndex') questionIndex: string,
    @Query('voice') voice: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.interviewPrepService.getCbtAnswerAudio(req, res, userId, id, Number(questionIndex), voice);
  }

  // ---- Ask AI ----
  // Free-form Q&A about this interview prep. Body: { question, focusIndex? }
  // where focusIndex is the question the person is looking at (optional).

  @Get(':id/ask')
  getAskAi(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.getAskAiMessages(userId, id);
  }

  @Post(':id/ask')
  askAi(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AskAiDto) {
    return this.interviewPrepService.askAi(userId, id, dto);
  }

  @Delete(':id/ask')
  clearAskAi(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.clearAskAi(userId, id);
  }

  // Real synthesized speech (audio/wav) reading one saved Ask AI message
  // aloud - pass that exact message's own createdAt AND role (as returned by
  // GET/POST :id/ask) back as ?createdAt=&role=. Both are required to
  // identify a message unambiguously: a question and its answer are two
  // separate saved messages, and matching on createdAt alone previously let
  // a mixed-up timestamp resolve to the wrong one. ?voice= picks one of
  // GET /interview-prep/voices.
  @Get(':id/ask/message-audio')
  async getAskAiMessageAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('createdAt') createdAt: string,
    @Query('role') role: 'user' | 'assistant' | undefined,
    @Query('voice') voice: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.interviewPrepService.getAskAiMessageAudio(req, res, userId, id, new Date(createdAt).getTime(), role, voice);
  }

  // Voice input for Ask AI: multipart form field "audio" (a recording of a
  // spoken question). Transcribes only - never grades, saves, or sends
  // anything on its own - so the recognized text lands in the question box
  // for the person to review/edit, exactly like typing it themselves.
  @Post(':id/ask/transcribe')
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype)),
    }),
  )
  transcribeAskAiVoice(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @UploadedFile() audio: Express.Multer.File,
  ) {
    return this.interviewPrepService.transcribeAskAiVoice(userId, id, audio);
  }

  // ---- Voice interview ----
  // The AI asks each question out loud with real synthesized speech (see
  // question-audio below - same voice-tutor mechanism as the skill
  // tutorials), the candidate answers by recording themselves, and the
  // recording is uploaded here per question.

  // State of the current attempt - questions (without their model answers,
  // so this plays out like a real interview), progress, and the final
  // result once every question has been answered.
  @Get(':id/voice-interview')
  getVoiceInterview(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.getVoiceInterview(userId, id);
  }

  // Multipart: form field "audio" (the recording) + "questionIndex".
  // Transcribes + grades the answer, and auto-finalizes the interview
  // (overall score + summary) once every question has been answered.
  @Post(':id/voice-interview/answer')
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(), // held in memory only long enough to send to Gemini - never written to disk
      limits: { fileSize: 20 * 1024 * 1024 }, // 20MB - generous for a single spoken answer
      fileFilter: (_req, file, cb) => cb(null, /^audio\//.test(file.mimetype)),
    }),
  )
  answerVoiceQuestion(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: SubmitVoiceAnswerDto,
    @UploadedFile() audio: Express.Multer.File,
  ) {
    return this.interviewPrepService.answerVoiceQuestion(userId, id, dto.questionIndex, audio);
  }

  // Clears progress so the candidate can redo the same set of questions.
  @Post(':id/voice-interview/restart')
  restartVoiceInterview(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.interviewPrepService.restartVoiceInterview(userId, id);
  }

  // The real voice tutor for this interview: streams synthesized speech
  // (audio/wav) asking the given question. ?voice= picks one of
  // GET /interview-prep/voices (defaults to the app's default voice).
  // Cached per (question, voice) after the first full play, so repeat plays
  // - including the "Replay question" button - are instant afterward.
  // Supports HTTP Range once cached, for instant seeking.
  @Get(':id/voice-interview/question-audio')
  async getQuestionAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('questionIndex') questionIndex: string,
    @Query('voice') voice: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.interviewPrepService.getQuestionAudio(req, res, userId, id, Number(questionIndex), voice);
  }
}
