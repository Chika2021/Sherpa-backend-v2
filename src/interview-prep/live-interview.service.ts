import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Request, Response } from 'express';
import { InterviewPrep } from '../entities/interview-prep.entity';
import { LiveInterview, LiveInterviewResult, LiveInterviewTurn } from '../entities/live-interview.entity';
import { GeminiService } from '../ai/gemini.service';
import { AudioService } from '../audio/audio.service';
import { assertValidId, ownedBy } from '../database/db-utils';
import { updateLockedRow } from '../database/locked-row.util';
import { StartLiveInterviewDto } from './dto/start-live-interview.dto';
import { ReplyLiveInterviewDto } from './dto/reply-live-interview.dto';
import type { LiveInterviewAction, LiveInterviewJob, LiveInterviewRound } from '../ai/live-interview.prompts';

const LORA_DEFAULT_VOICE = 'Aoede'; // "Smooth and conversational" - see AVAILABLE_TTS_VOICES
const DEFAULT_QUESTION_COUNT = 6;
const MAX_FOLLOW_UPS = 2; // per main question
const MAX_TURNS = 120; // hard ceiling on a single conversation (a normal 10-question interview is ~60)
const HISTORY_TURNS = 50; // how much of the conversation Lora is shown on each reply
const LOCK_STALE_MS = 120_000; // a reply that's been "generating" this long is assumed dead
const MAX_SESSIONS_LISTED = 20;

/**
 * "Live Interview with Lora": a real-time, adaptive mock interview.
 *
 * Division of labour:
 *  - THIS service owns the structure - how many questions, how many follow-ups
 *    per question, when it ends, token billing, ownership, concurrency.
 *  - The model (GeminiService.liveInterviewTurn) owns the conversation - it
 *    reacts to what the candidate actually said and chooses, from the moves
 *    this service currently allows, between probing deeper and moving on.
 *
 * Billing: ONE token per interview, charged when it starts (after Lora's
 * opening was generated successfully). Every later model call is free - see
 * the `liveInterview*` entries in token-pricing.config.ts.
 */
@Injectable()
export class LiveInterviewService {
  private readonly logger = new Logger(LiveInterviewService.name);

  constructor(
    @InjectRepository(LiveInterview) private live: Repository<LiveInterview>,
    @InjectRepository(InterviewPrep) private preps: Repository<InterviewPrep>,
    @InjectDataSource() private dataSource: DataSource,
    private gemini: GeminiService,
    private audio: AudioService,
  ) {}

  // ---- Reading ----

  /** Every attempt for this interview prep (newest first, without transcripts) plus the one in progress, if any. */
  async list(userId: string, prepId: string) {
    await this.findPrep(userId, prepId);
    const sessions = await this.live.find({
      where: { userId, interviewPrepId: prepId },
      order: { createdAt: 'DESC' },
      take: MAX_SESSIONS_LISTED,
    });

    const active = sessions.find((s) => s.status === 'in_progress');
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        status: s.status,
        voice: s.voice,
        totalQuestions: s.totalQuestions,
        answeredCount: this.answeredCount(s.turns),
        overallScore: s.result?.overallScore ?? null,
        createdAt: (s as any).createdAt,
        completedAt: s.completedAt ?? null,
      })),
      activeSessionId: active?.id ?? null,
    };
  }

  async get(userId: string, prepId: string, sessionId: string) {
    const session = await this.findSession(userId, prepId, sessionId);
    return this.toState(session);
  }

  // ---- Starting ----

  /**
   * Starts an interview and returns Lora's opening line. If one is already in
   * progress it is resumed (`resumed: true`) unless `restart` is set, so a
   * refresh or an accidental second tap never silently throws away - or
   * pays again for - a conversation.
   */
  async start(userId: string, prepId: string, dto: StartLiveInterviewDto) {
    const prep = await this.findPrep(userId, prepId);

    const existing = await this.live.findOne({ where: { userId, interviewPrepId: prepId, status: 'in_progress' } });
    if (existing && !dto.restart) {
      return { resumed: true, ...this.toState(existing) };
    }

    const voice = this.gemini.assertValidVoiceName(dto.voice || LORA_DEFAULT_VOICE);
    const totalQuestions = dto.questionCount ?? DEFAULT_QUESTION_COUNT;

    // Fail before spending an AI call if they can't pay for the interview.
    await this.gemini.assertCanAffordFeature(userId, 'liveInterview');

    const opening = await this.gemini.liveInterviewOpening(userId, this.jobOf(prep), this.bankOf(prep), totalQuestions);

    if (existing) {
      await this.live.update({ id: existing.id, status: 'in_progress' }, { status: 'abandoned', completedAt: new Date() });
    }

    const session = await this.live.save(
      this.live.create({
        userId,
        interviewPrepId: prepId,
        status: 'in_progress',
        voice,
        totalQuestions,
        maxFollowUps: MAX_FOLLOW_UPS,
        questionsAsked: 1,
        followUpsOnCurrent: 0,
        turns: [{ role: 'interviewer', kind: 'opening', content: opening, createdAt: new Date() }],
        result: null,
        processingSince: null,
      }),
    );

    // Billed once the interview actually exists (a failed opening above costs nothing).
    await this.gemini.chargeFeature(userId, 'liveInterview');

    return { resumed: false, ...this.toState(session) };
  }

  // ---- The conversation ----

  /**
   * The candidate answers (recording OR typed text) and Lora replies: a
   * follow-up on what they just said, the next question, or the closing. When
   * Lora closes, the interview is finalized and the report is included.
   */
  async reply(
    userId: string,
    prepId: string,
    sessionId: string,
    dto: ReplyLiveInterviewDto,
    audioFile?: Express.Multer.File,
  ) {
    const typed = (dto.answer ?? '').trim();
    const hasAudio = !!audioFile?.buffer?.length;
    if (!hasAudio && !typed) throw new BadRequestException('Say or type your answer first.');

    const prep = await this.findPrep(userId, prepId);
    const session = await this.acquireLock(userId, prepId, sessionId);

    try {
      if (session.turns.length >= MAX_TURNS) {
        throw new BadRequestException('This interview has gone on long enough - please end it to get your feedback.');
      }

      const allowed = this.allowedMoves(session);
      const result = await this.gemini.liveInterviewTurn(userId, {
        job: this.jobOf(prep),
        bank: this.bankOf(prep),
        history: session.turns.slice(-HISTORY_TURNS).map((t) => ({ role: t.role, content: t.content })),
        candidate: hasAudio
          ? { audio: { base64: audioFile!.buffer.toString('base64'), mimeType: audioFile!.mimetype } }
          : { text: typed },
        allowed,
        progress: {
          questionsAsked: session.questionsAsked,
          totalQuestions: session.totalQuestions,
          followUpsOnCurrent: session.followUpsOnCurrent,
          maxFollowUps: session.maxFollowUps,
        },
        askedMainQuestions: session.turns
          .filter((t) => t.role === 'interviewer' && (t.kind === 'opening' || t.kind === 'next_question'))
          .map((t) => t.content),
      });

      const now = new Date();
      const base = session.turns.length;
      const newTurns: LiveInterviewTurn[] = [];
      const update: Record<string, any> = {};

      let questionsAsked = session.questionsAsked;
      let followUpsOnCurrent = session.followUpsOnCurrent;
      let completed = false;

      if (!result.heard) {
        // Nothing was understood: Lora asks them to repeat. No candidate turn is stored (so a
        // mumbled attempt never pollutes the transcript) and nothing counts against the interview.
        newTurns.push({ role: 'interviewer', kind: 'repeat', content: result.spoken, createdAt: now });
      } else {
        newTurns.push({
          role: 'candidate',
          content: result.transcript,
          inputMode: hasAudio ? 'voice' : 'text',
          assessment: result.assessment ?? undefined,
          createdAt: now,
        });
        newTurns.push({
          role: 'interviewer',
          kind: result.kind as LiveInterviewAction,
          content: result.spoken,
          createdAt: new Date(now.getTime() + 1),
        });

        if (result.kind === 'next_question') {
          questionsAsked += 1;
          followUpsOnCurrent = 0;
        } else if (result.kind === 'follow_up') {
          followUpsOnCurrent += 1;
        } else if (result.kind === 'closing') {
          completed = true;
        }
        update.set = { questionsAsked, followUpsOnCurrent, ...(completed ? { status: 'completed', completedAt: now } : {}) };
      }
      // One atomic write (row-locked): append the new turns AND move the counters/status together - the old $push + $set.
      await updateLockedRow<{ turns: LiveInterviewTurn[] | null }>(
        this.dataSource,
        LiveInterview,
        { id: session.id },
        ['turns'],
        (row) => ({ turns: [...(row.turns ?? []), ...newTurns], ...(update.set ?? {}) }),
        ['questionsAsked', 'followUpsOnCurrent', 'status', 'completedAt'],
      );

      // Lora has said goodbye: build the report now. If that fails the interview is still
      // saved as completed, and POST .../end (or just reopening it) can generate the report later.
      let finalResult: LiveInterviewResult | null = null;
      if (completed) {
        try {
          finalResult = await this.buildResult(userId, prep, [...session.turns, ...newTurns], false);
          await this.live.update({ id: session.id }, { result: finalResult as any });
        } catch (err) {
          this.logger.error(`Live interview ${session.id}: report generation failed: ${(err as Error).message}`);
        }
      }

      const interviewerTurn = newTurns[newTurns.length - 1];
      return {
        heard: result.heard,
        candidate: result.heard
          ? { turnIndex: base, content: result.transcript, inputMode: hasAudio ? 'voice' : 'text', createdAt: newTurns[0].createdAt }
          : null,
        interviewer: {
          turnIndex: base + newTurns.length - 1,
          content: interviewerTurn.content,
          kind: interviewerTurn.kind,
          createdAt: interviewerTurn.createdAt,
        },
        progress: {
          questionsAsked,
          totalQuestions: session.totalQuestions,
          followUpsOnCurrent,
          maxFollowUps: session.maxFollowUps,
          answeredCount: this.answeredCount(session.turns) + (result.heard ? 1 : 0),
        },
        completed,
        result: finalResult,
      };
    } finally {
      await this.live.update({ id: session.id }, { processingSince: null });
    }
  }

  /**
   * Ends the interview now and produces the report. Also the way to (re)generate
   * the report for an interview that finished but whose report failed to generate.
   * Ending before answering anything marks it abandoned - there is nothing to score.
   */
  async end(userId: string, prepId: string, sessionId: string) {
    const prep = await this.findPrep(userId, prepId);
    let session = await this.findSession(userId, prepId, sessionId);

    if (session.status === 'in_progress') {
      session = await this.acquireLock(userId, prepId, sessionId);
      try {
        if (!this.answeredCount(session.turns)) {
          await this.live.update({ id: session.id }, { status: 'abandoned', completedAt: new Date() });
        } else {
          // Persist the new status first, so a failed report below can simply be retried.
          await this.live.update({ id: session.id }, { status: 'ended_early', completedAt: new Date() });
          const result = await this.buildResult(userId, prep, session.turns, true);
          await this.live.update({ id: session.id }, { result: result as any });
        }
      } finally {
        await this.live.update({ id: session.id }, { processingSince: null });
      }
    } else if ((session.status === 'completed' || session.status === 'ended_early') && !session.result) {
      const result = await this.buildResult(userId, prep, session.turns, session.status === 'ended_early');
      await this.live.update({ id: session.id }, { result: result as any });
    }

    return this.get(userId, prepId, sessionId);
  }

  async remove(userId: string, prepId: string, sessionId: string) {
    const session = await this.findSession(userId, prepId, sessionId);
    await this.live.delete({ id: session.id });
    return { deleted: true };
  }

  // ---- Lora's voice ----

  /**
   * Streams Lora's real synthesized voice for one of her turns. Only interviewer
   * turns can be spoken - a candidate turn is their own words. Synthesized audio
   * is cached by text + voice (see AudioService), so replays are instant.
   */
  async getTurnAudio(
    req: Request,
    res: Response,
    userId: string,
    prepId: string,
    sessionId: string,
    turnIndex: number,
    voice: string | undefined,
  ): Promise<void> {
    const session = await this.findSession(userId, prepId, sessionId);
    const turn = Number.isInteger(turnIndex) ? session.turns[turnIndex] : undefined;
    if (!turn || turn.role !== 'interviewer') throw new BadRequestException('Invalid turn index.');
    await this.audio.serveAudio(req, res, 'live-interview-turn', `${session.id}:${turnIndex}`, turn.content, voice || session.voice);
  }

  // ---- Internals ----

  /** What Lora is allowed to do after the answer being processed, given where the interview stands. */
  private allowedMoves(s: LiveInterview): LiveInterviewAction[] {
    const canFollowUp = s.followUpsOnCurrent < s.maxFollowUps;
    const onLastQuestion = s.questionsAsked >= s.totalQuestions;
    if (onLastQuestion) return canFollowUp ? ['follow_up', 'closing'] : ['closing'];
    return canFollowUp ? ['follow_up', 'next_question'] : ['next_question'];
  }

  private answeredCount(turns: LiveInterviewTurn[] | undefined): number {
    return (turns ?? []).filter((t) => t.role === 'candidate').length;
  }

  /**
   * Overall score = plain average of the per-answer scores (computed here, not
   * by the AI); the AI only writes the qualitative summary.
   */
  private async buildResult(
    userId: string,
    prep: InterviewPrep,
    turns: LiveInterviewTurn[],
    endedEarly: boolean,
  ): Promise<LiveInterviewResult> {
    const rounds: LiveInterviewRound[] = [];
    turns.forEach((t, i) => {
      if (t.role !== 'candidate') return;
      const asked = [...turns.slice(0, i)].reverse().find((x) => x.role === 'interviewer' && x.kind !== 'repeat');
      rounds.push({
        asked: asked?.content ?? '',
        answer: t.content,
        score: t.assessment?.score ?? 0,
        note: t.assessment?.note ?? '',
      });
    });
    if (!rounds.length) throw new BadRequestException('There were no answers to review.');

    const overallScore = Math.round(rounds.reduce((sum, r) => sum + r.score, 0) / rounds.length);
    const { summary, strengths, improvements } = await this.gemini.summarizeLiveInterview(
      userId,
      { title: prep.jobTitle },
      rounds,
      endedEarly,
    );
    return { overallScore, summary, strengths, improvements, answeredCount: rounds.length, endedEarly };
  }

  /**
   * Atomically claims the right to generate the next reply for this session, so
   * a double-tap (or two tabs) can't produce two Lora replies to one answer.
   * Returns the session as it was when claimed.
   */
  private async acquireLock(userId: string, prepId: string, sessionId: string): Promise<LiveInterview> {
    const owned = { ...ownedBy(sessionId, userId, 'Live interview'), interviewPrepId: prepId };
    assertValidId(prepId, 'Interview prep');
    const stale = new Date(Date.now() - LOCK_STALE_MS);

    // One conditional UPDATE: it only succeeds if no reply is currently being generated (or the lock is stale).
    const claim = await this.live
      .createQueryBuilder()
      .update(LiveInterview)
      .set({ processingSince: new Date() })
      .where('"id" = :id', { id: owned.id })
      .andWhere('"userId" = :userId', { userId: owned.userId })
      .andWhere('"interviewPrepId" = :prepId', { prepId })
      .andWhere('"status" = :status', { status: 'in_progress' })
      .andWhere('("processingSince" IS NULL OR "processingSince" < :stale)', { stale })
      .execute();
    if (claim.affected) {
      // Nothing else can change this row while the lock is held, so reading it now gives the pre-lock state.
      return this.live.findOneByOrFail({ id: owned.id });
    }

    const existing = await this.live.findOne({ where: owned, select: { id: true, status: true } });
    if (!existing) throw new NotFoundException('Live interview not found');
    if (existing.status !== 'in_progress') throw new BadRequestException('This interview has already finished.');
    throw new ConflictException('Lora is still replying - give her a moment.');
  }

  private async findPrep(userId: string, id: string): Promise<InterviewPrep> {
    const prep = await this.preps.findOneBy(ownedBy(id, userId, 'Interview prep'));
    if (!prep) throw new NotFoundException('Interview prep not found');
    return prep;
  }

  private async findSession(userId: string, prepId: string, sessionId: string): Promise<LiveInterview> {
    assertValidId(prepId, 'Interview prep');
    const session = await this.live.findOne({
      where: { ...ownedBy(sessionId, userId, 'Live interview'), interviewPrepId: prepId },
    });
    if (!session) throw new NotFoundException('Live interview not found');
    return session;
  }

  private jobOf(prep: InterviewPrep): LiveInterviewJob {
    return { title: prep.jobTitle, description: prep.jobDescription, requirements: prep.jobRequirements };
  }

  /** The prepared questions, WITHOUT their model answers - Lora is an interviewer, not an answer key. */
  private bankOf(prep: InterviewPrep) {
    return (prep.questions ?? []).map((q) => ({ question: q.question, category: q.category }));
  }

  /**
   * The API shape. The private per-answer scores/notes are withheld until the
   * interview is over so it plays out like a real one (the same way the CBT
   * quiz withholds answers and the voice interview withholds model answers).
   */
  private toState(s: LiveInterview) {
    const finished = s.status !== 'in_progress';
    return {
      sessionId: s.id,
      interviewPrepId: s.interviewPrepId.toString(),
      status: s.status,
      voice: s.voice,
      totalQuestions: s.totalQuestions,
      maxFollowUps: s.maxFollowUps,
      questionsAsked: s.questionsAsked,
      followUpsOnCurrent: s.followUpsOnCurrent,
      answeredCount: this.answeredCount(s.turns),
      completed: finished,
      busy: !!s.processingSince && Date.now() - new Date(s.processingSince).getTime() < LOCK_STALE_MS,
      turns: (s.turns ?? []).map((t, turnIndex) => ({
        turnIndex,
        role: t.role,
        content: t.content,
        kind: t.kind,
        inputMode: t.inputMode,
        createdAt: t.createdAt,
        ...(finished && t.assessment ? { assessment: t.assessment } : {}),
      })),
      result: s.result ?? null,
      startedAt: (s as any).createdAt,
      completedAt: s.completedAt ?? null,
    };
  }
}
