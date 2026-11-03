import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SkillsService } from './skills.service';
import { SkillVideosService } from './skill-videos.service';
import { FindSkillVideosDto } from './dto/find-skill-videos.dto';
import { CreateSkillTutorialDto } from './dto/create-skill-tutorial.dto';
import { AnswerSkillCbtQuestionDto } from './dto/answer-skill-cbt-question.dto';
import { SubmitLabAttemptDto } from './dto/submit-lab-attempt.dto';
import { AskAiDto } from '../common/dto/ask-ai.dto';

@UseGuards(JwtAuthGuard)
@Controller('skills')
export class SkillsController {
  constructor(
    private skillsService: SkillsService,
    private videosService: SkillVideosService,
  ) {}

  // The voices the voice tutor can read in. Declared before ':id' below so
  // "voices" isn't swallowed as an :id param.
  @Get('voices')
  getAvailableVoices() {
    return this.skillsService.getAvailableVoices();
  }

  // Generates a complete tutorial for a user-typed skill/course name.
  // Body: { skillName, level? }
  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateSkillTutorialDto) {
    return this.skillsService.create(userId, dto);
  }

  @Get()
  findAll(@CurrentUser('id') userId: string) {
    return this.skillsService.findAllForUser(userId);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.findOne(userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.remove(userId, id);
  }

  // ---- Tutorial videos ----
  // The course's saved tutorial videos (kept out of GET /skills/:id to keep that payload small).
  @Get(':id/videos')
  listVideos(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.videosService.list(userId, id);
  }

  // Has the AI find `count` real tutorial videos on the internet for this course
  // and adds them. Body: { count } (1-20). Costs 1 AI token per search.
  @Post(':id/videos')
  findVideos(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: FindSkillVideosDto) {
    return this.videosService.find(userId, id, dto.count);
  }

  // Deletes every video from the course.
  @Delete(':id/videos')
  removeAllVideos(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.videosService.removeAll(userId, id);
  }

  // Deletes one video (its YouTube id) from the course.
  @Delete(':id/videos/:videoId')
  removeVideo(@CurrentUser('id') userId: string, @Param('id') id: string, @Param('videoId') videoId: string) {
    return this.videosService.remove(userId, id, videoId);
  }

  // Ordered, spoken-friendly text per module plus a rough duration estimate
  // and the list of available voices, for the client to drive a
  // play/pause/progress/voice-picker UI around the audio below.
  @Get(':id/narration')
  getNarration(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.getNarration(userId, id);
  }

  // The real voice tutor: streams synthesized speech (audio/wav) for this
  // tutorial's narration. Omit ?moduleIndex= to read the whole tutorial, or
  // pass it to read just that module. ?voice= picks one of GET /skills/voices
  // (defaults to the app's default voice). ?variant=material reads that
  // module's full detailedMaterial lesson instead of the short narration
  // (defaults to "narration"). Material is read ONE "##" HEADING AT A TIME:
  // pass ?moduleIndex=M&sectionIndex=S (the headings are listed per module in
  // GET :id/narration -> modules[].sections; sectionIndex defaults to 0). Supports HTTP Range for instant seeking once
  // a given (module, variant, voice) combination has been generated before.
  @Get(':id/narration/audio')
  async getNarrationAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('moduleIndex') moduleIndex: string | undefined,
    @Query('voice') voice: string | undefined,
    @Query('variant') variant: string | undefined,
    @Query('sectionIndex') sectionIndex: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const parsedModuleIndex = moduleIndex !== undefined && moduleIndex !== '' ? Number(moduleIndex) : undefined;
    const parsedSectionIndex = sectionIndex !== undefined && sectionIndex !== '' ? Number(sectionIndex) : undefined;
    const parsedVariant = variant === 'material' ? 'material' : 'narration';
    await this.skillsService.getNarrationAudio(
      req,
      res,
      userId,
      id,
      parsedModuleIndex,
      voice,
      parsedVariant,
      parsedSectionIndex,
    );
  }

  // Backfills detailedMaterial for any module missing it (tutorials
  // generated before this field existed). Body: { regenerateAll?: boolean }
  // - pass true to rewrite it for every module instead of just the gaps.
  @Post(':id/material')
  generateMaterial(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body('regenerateAll') regenerateAll: boolean | undefined,
  ) {
    return this.skillsService.generateMaterial(userId, id, !!regenerateAll);
  }

  // Renders (or reuses a cached render of) the tutorial as a downloadable PDF.
  @Post(':id/download')
  downloadTutorial(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.downloadTutorial(userId, id);
  }

  // ---- Ask AI ----
  // Free-form Q&A about this course. Body: { question, focusIndex? } where
  // focusIndex is the module the learner is reading (optional).

  @Get(':id/ask')
  getAskAi(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.getAskAiMessages(userId, id);
  }

  @Post(':id/ask')
  askAi(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AskAiDto) {
    return this.skillsService.askAi(userId, id, dto);
  }

  @Delete(':id/ask')
  clearAskAi(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.clearAskAi(userId, id);
  }

  // Real synthesized speech (audio/wav) reading one saved Ask AI message
  // aloud - pass that exact message's own createdAt AND role (as returned by
  // GET/POST :id/ask) back as ?createdAt=&role=. Both are required to
  // identify a message unambiguously: a question and its answer are two
  // separate saved messages, and matching on createdAt alone previously let
  // a mixed-up timestamp resolve to the wrong one. ?voice= picks one of
  // GET /skills/voices.
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
    await this.skillsService.getAskAiMessageAudio(req, res, userId, id, new Date(createdAt).getTime(), role, voice);
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
  transcribeAskAiVoice(@CurrentUser('id') userId: string, @Param('id') id: string, @UploadedFile() audio: Express.Multer.File) {
    return this.skillsService.transcribeAskAiVoice(userId, id, audio);
  }

  // ---- CBT ----

  @Post(':id/cbt')
  generateCbt(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.generateCbt(userId, id);
  }

  @Get(':id/cbt')
  getCbt(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.getCbt(userId, id);
  }

  // Grades one answer and returns the correction (correctOptionIndex +
  // explanation) to show before advancing when the answer is wrong.
  @Post(':id/cbt/answer')
  answerCbt(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AnswerSkillCbtQuestionDto) {
    return this.skillsService.answerCbtQuestion(userId, id, dto);
  }

  @Post(':id/cbt/restart')
  restartCbt(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.restartCbt(userId, id);
  }

  // Real synthesized speech reading the CBT question aloud. ?voice= picks
  // one of GET /skills/voices. Cached per (question, voice).
  @Get(':id/cbt/question-audio')
  async getCbtQuestionAudio(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('questionIndex') questionIndex: string,
    @Query('voice') voice: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    await this.skillsService.getCbtQuestionAudio(req, res, userId, id, Number(questionIndex), voice);
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
    await this.skillsService.getCbtAnswerAudio(req, res, userId, id, Number(questionIndex), voice);
  }

  // ---- Lab (real-time practice) ----

  @Post(':id/lab')
  generateLab(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.generateLab(userId, id);
  }

  @Get(':id/lab')
  getLab(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.skillsService.getLab(userId, id);
  }

  // Grades one attempt in real time; the same exercise can be resubmitted afterward.
  @Post(':id/lab/attempt')
  submitLabAttempt(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: SubmitLabAttemptDto) {
    return this.skillsService.submitLabAttempt(userId, id, dto);
  }
}
