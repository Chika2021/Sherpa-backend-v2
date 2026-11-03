import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Request, Response } from 'express';
import {
  InterviewPrep,
  CbtAnswer,
  VoiceAnswer,
  VoiceInterviewResult,
} from '../entities/interview-prep.entity';
import { GeminiService } from '../ai/gemini.service';
import { AudioService } from '../audio/audio.service';
import { CreateInterviewPrepDto } from './dto/create-interview-prep.dto';
import { AnswerCbtQuestionDto } from './dto/answer-cbt-question.dto';
import { assertValidId, ownedBy } from '../database/db-utils';
import { appendKeepingLast, updateLockedRow } from '../database/locked-row.util';
import { AskAiDto } from '../common/dto/ask-ai.dto';
import { ASK_AI_MAX_STORED_MESSAGES } from '../common/ask-ai.types';

@Injectable()
export class InterviewPrepService {
  constructor(
    @InjectRepository(InterviewPrep) private preps: Repository<InterviewPrep>,
    @InjectDataSource() private dataSource: DataSource,
    private gemini: GeminiService,
    private audio: AudioService,
  ) {}

  /** Generates interview questions + model answers for a job and saves them. */
  async create(userId: string, dto: CreateInterviewPrepDto) {
    const questions = await this.gemini.generateInterviewQuestions(
      userId,
      { title: dto.jobTitle, description: dto.jobDescription, requirements: dto.jobRequirements },
      dto.count ?? 10,
    );

    if (!questions.length) {
      throw new BadRequestException('The AI did not return any interview questions. Please try again.');
    }

    assertValidId(userId, 'User');
    return this.preps.save(
      this.preps.create({
        userId,
        jobTitle: dto.jobTitle,
        jobDescription: dto.jobDescription,
        jobRequirements: dto.jobRequirements,
        questions,
      }),
    );
  }

  findAllForUser(userId: string) {
    assertValidId(userId, 'User');
    return this.preps.find({
      where: { userId },
      select: {
        id: true,
        jobTitle: true,
        jobRequirements: true,
        questions: true,
        cbtQuestions: true,
        cbtCompleted: true,
        voiceAnswers: true,
        voiceInterviewCompleted: true,
        voiceInterviewResult: true,
        createdAt: true,
      },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string): Promise<InterviewPrep> {
    const record = await this.preps.findOneBy(ownedBy(id, userId, 'Interview prep'));
    if (!record) throw new NotFoundException('Interview prep not found');
    return record;
  }

  /** Same as findOne, but also loads the (normally hidden) saved Ask AI conversation. */
  private async findWithAskAi(userId: string, id: string): Promise<InterviewPrep> {
    const record = await this.preps
      .createQueryBuilder('p')
      .addSelect('p.askAiMessages')
      .where('p.id = :id AND p.userId = :userId', ownedBy(id, userId, 'Interview prep'))
      .getOne();
    if (!record) throw new NotFoundException('Interview prep not found');
    return record;
  }

  async remove(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    await this.preps.delete({ id: record.id });
    return { deleted: true };
  }

  /** Generates (or regenerates) the CBT multiple-choice quiz from this session's questions, resetting progress. */
  async generateCbt(userId: string, id: string) {
    const record = await this.findOne(userId, id);

    const cbtQuestions = await this.gemini.generateCbtQuestions(userId, record.questions, { title: record.jobTitle });
    if (!cbtQuestions.length) {
      throw new BadRequestException('The AI did not return any CBT questions. Please try again.');
    }

    record.cbtQuestions = cbtQuestions;
    record.cbtAnswers = [];
    record.cbtCompleted = false;
    await this.preps.save(record);

    return this.getCbt(userId, id);
  }

  /**
   * Returns the CBT quiz state with answers withheld for questions the user
   * hasn't submitted yet, so taking it client-side behaves like a real quiz
   * rather than exposing the answer key up front.
   */
  async getCbt(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    if (!record.cbtQuestions?.length) {
      throw new NotFoundException('No CBT has been generated for this interview prep yet.');
    }

    const answeredByIndex = new Map(record.cbtAnswers.map((a) => [a.questionIndex, a]));

    const questions = record.cbtQuestions.map((q, index) => {
      const answered = answeredByIndex.get(index);
      if (!answered) {
        return { questionIndex: index, question: q.question, options: q.options, answered: false as const };
      }
      return {
        questionIndex: index,
        question: q.question,
        options: q.options,
        answered: true as const,
        selectedOptionIndex: answered.selectedOptionIndex,
        correctOptionIndex: q.correctOptionIndex,
        correct: answered.correct,
        explanation: q.explanation,
      };
    });

    const score = record.cbtAnswers.filter((a) => a.correct).length;

    return {
      interviewPrepId: record.id,
      totalQuestions: record.cbtQuestions.length,
      answeredCount: record.cbtAnswers.length,
      score,
      completed: record.cbtCompleted,
      questions,
    };
  }

  /** Grades one answer, shows the correction if wrong, and records progress. Re-submitting an already-answered question just returns its recorded result unchanged. */
  async answerCbtQuestion(userId: string, id: string, dto: AnswerCbtQuestionDto) {
    const record = await this.findOne(userId, id);
    const cbtQuestions = record.cbtQuestions;
    if (!cbtQuestions?.length) {
      throw new NotFoundException('No CBT has been generated for this interview prep yet.');
    }
    const question = cbtQuestions[dto.questionIndex];
    if (!question) throw new BadRequestException('Invalid question index.');
    if (dto.selectedOptionIndex < 0 || dto.selectedOptionIndex >= question.options.length) {
      throw new BadRequestException('Invalid option index.');
    }

    const existing = record.cbtAnswers.find((a) => a.questionIndex === dto.questionIndex);
    if (existing) {
      return {
        questionIndex: dto.questionIndex,
        selectedOptionIndex: existing.selectedOptionIndex,
        correct: existing.correct,
        correctOptionIndex: question.correctOptionIndex,
        explanation: question.explanation,
        ...this.progress(record),
      };
    }

    const correct = dto.selectedOptionIndex === question.correctOptionIndex;
    const answer: CbtAnswer = { questionIndex: dto.questionIndex, selectedOptionIndex: dto.selectedOptionIndex, correct };
    record.cbtAnswers.push(answer);
    if (record.cbtAnswers.length >= cbtQuestions.length) record.cbtCompleted = true;
    await this.preps.save(record);

    return {
      questionIndex: dto.questionIndex,
      selectedOptionIndex: dto.selectedOptionIndex,
      correct,
      // The correction: sent back regardless of right/wrong so the client can
      // always show "why", but it's the wrong-answer case where the caller
      // actually needs to display it before advancing.
      correctOptionIndex: question.correctOptionIndex,
      explanation: question.explanation,
      ...this.progress(record),
    };
  }

  /** Clears progress on the current CBT quiz (same questions) so the user can retake it. */
  async restartCbt(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    if (!record.cbtQuestions?.length) {
      throw new NotFoundException('No CBT has been generated for this interview prep yet.');
    }
    record.cbtAnswers = [];
    record.cbtCompleted = false;
    await this.preps.save(record);
    return this.getCbt(userId, id);
  }

  private progress(record: InterviewPrep) {
    return {
      answeredCount: record.cbtAnswers.length,
      totalQuestions: record.cbtQuestions?.length ?? 0,
      score: record.cbtAnswers.filter((a) => a.correct).length,
      completed: record.cbtCompleted,
    };
  }

  // ---- Voice interview ----
  // Reuses this session's `questions` (same ones shown with model answers,
  // and used to build the CBT) - the candidate answers by speaking instead
  // of reading a model answer or picking from options.

  /**
   * Current voice-interview state: each question with its answered status
   * and (once answered) the transcript/score/feedback, plus the overall
   * result once every question has been answered. idealAnswer is
   * deliberately omitted from each question here (unlike GET /:id) so this
   * plays out like a real interview rather than an open-book one.
   */
  async getVoiceInterview(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    const answeredByIndex = new Map(record.voiceAnswers.map((a) => [a.questionIndex, a]));

    const questions = record.questions.map((q, index) => {
      const answered = answeredByIndex.get(index);
      return {
        questionIndex: index,
        question: q.question,
        category: q.category,
        answered: !!answered,
        ...(answered
          ? {
              transcript: answered.transcript,
              score: answered.score,
              feedback: answered.feedback,
              strengths: answered.strengths,
              improvements: answered.improvements,
            }
          : {}),
      };
    });

    return {
      interviewPrepId: record.id,
      jobTitle: record.jobTitle,
      totalQuestions: record.questions.length,
      answeredCount: record.voiceAnswers.length,
      completed: record.voiceInterviewCompleted,
      result: record.voiceInterviewResult,
      questions,
    };
  }

  /**
   * Transcribes and grades one spoken answer (audio -> Gemini in a single
   * call). Automatically finalizes the interview - overall score (a plain
   * average, computed here, not by the AI) plus an AI-written summary of
   * recurring strengths/improvements - once every question has an answer.
   * Re-submitting an already-answered question overwrites that answer (and
   * re-finalizes if it was the completing one), so a single question can be
   * redone without restarting the whole interview.
   */
  async answerVoiceQuestion(userId: string, id: string, questionIndex: number, audioFile?: Express.Multer.File) {
    const record = await this.findOne(userId, id);
    const question = record.questions[questionIndex];
    if (!question) throw new BadRequestException('Invalid question index.');
    if (!audioFile?.buffer?.length) {
      throw new BadRequestException('No audio was received - please record an answer before submitting.');
    }

    const evaluation = await this.gemini.evaluateVoiceAnswer(
      userId,
      { title: record.jobTitle, description: record.jobDescription, requirements: record.jobRequirements },
      question,
      { base64: audioFile.buffer.toString('base64'), mimeType: audioFile.mimetype },
    );

    const answer: VoiceAnswer = { questionIndex, ...evaluation };
    const existingIndex = record.voiceAnswers.findIndex((a) => a.questionIndex === questionIndex);
    if (existingIndex >= 0) {
      record.voiceAnswers[existingIndex] = answer;
    } else {
      record.voiceAnswers.push(answer);
    }

    let result: VoiceInterviewResult | null = record.voiceInterviewResult ?? null;
    if (record.voiceAnswers.length >= record.questions.length) {
      record.voiceInterviewCompleted = true;
      result = await this.finalizeVoiceInterview(userId, record);
    }

    await this.preps.save(record);

    return {
      questionIndex,
      ...evaluation,
      answeredCount: record.voiceAnswers.length,
      totalQuestions: record.questions.length,
      completed: record.voiceInterviewCompleted,
      result,
    };
  }

  /** Clears all progress so the same set of questions can be re-attempted from scratch. */
  async restartVoiceInterview(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    record.voiceAnswers = [];
    record.voiceInterviewCompleted = false;
    record.voiceInterviewResult = null;
    await this.preps.save(record);
    return this.getVoiceInterview(userId, id);
  }

  // ---- Real voice tutor (question narration) ----
  // Same mechanism as the skill tutorial's voice tutor (see AudioService):
  // genuine Gemini-synthesized speech, streamed to the client as soon as
  // it's generated and cached afterward (globally, keyed by voice) so every
  // later play of the same question in the same voice is instant. This
  // replaces asking the question via the browser's own text-to-speech.

  /** The set of Gemini voices the interviewer can speak in. */
  getAvailableVoices() {
    return this.audio.getAvailableVoices();
  }

  /** Streams real synthesized speech for one interview question straight to the response. */
  async getQuestionAudio(
    req: Request,
    res: Response,
    userId: string,
    id: string,
    questionIndex: number,
    voice: string | undefined,
  ): Promise<void> {
    const record = await this.findOne(userId, id);
    const question = record.questions[questionIndex];
    if (!question) throw new BadRequestException('Invalid question index.');
    await this.audio.serveAudio(req, res, 'interview-question', `${record.id}:${questionIndex}`, question.question, voice);
  }

  // ---- CBT quiz read-aloud ----

  /** Reads a CBT question aloud - the question text itself isn't secret, so this works whether or not it's been answered yet. */
  async getCbtQuestionAudio(
    req: Request,
    res: Response,
    userId: string,
    id: string,
    questionIndex: number,
    voice: string | undefined,
  ): Promise<void> {
    const record = await this.findOne(userId, id);
    const question = record.cbtQuestions?.[questionIndex];
    if (!question) throw new BadRequestException('Invalid question index.');
    await this.audio.serveAudio(req, res, 'interview-cbt-question', `${record.id}:${questionIndex}`, question.question, voice);
  }

  /**
   * Reads the correct answer + explanation aloud - but only once the user
   * has actually answered this question. getCbt() already withholds
   * correctOptionIndex/explanation for unanswered questions for the same
   * reason; this check is what stops someone from hearing the answer via
   * this audio endpoint before picking an option.
   */
  async getCbtAnswerAudio(
    req: Request,
    res: Response,
    userId: string,
    id: string,
    questionIndex: number,
    voice: string | undefined,
  ): Promise<void> {
    const record = await this.findOne(userId, id);
    const question = record.cbtQuestions?.[questionIndex];
    if (!question) throw new BadRequestException('Invalid question index.');
    const answered = record.cbtAnswers.some((a) => a.questionIndex === questionIndex);
    if (!answered) throw new BadRequestException('Answer this question first.');
    const text = `The correct answer is: ${question.options[question.correctOptionIndex]}. ${question.explanation}`;
    await this.audio.serveAudio(req, res, 'interview-cbt-answer', `${record.id}:${questionIndex}`, text, voice);
  }

  private async finalizeVoiceInterview(userId: string, record: InterviewPrep): Promise<VoiceInterviewResult> {
    const sorted = [...record.voiceAnswers].sort((a, b) => a.questionIndex - b.questionIndex);
    const overallScore = Math.round(sorted.reduce((sum, a) => sum + a.score, 0) / sorted.length);

    const rounds = sorted.map((a) => ({
      question: record.questions[a.questionIndex]?.question ?? '',
      transcript: a.transcript,
      score: a.score,
    }));

    const { summary, strengths, improvements } = await this.gemini.summarizeVoiceInterview(
      userId,
      { title: record.jobTitle },
      rounds,
    );

    const result: VoiceInterviewResult = { overallScore, summary, strengths, improvements };
    record.voiceInterviewResult = result;
    return result;
  }

  // ---- Ask AI ----

  /** The saved "Ask AI" conversation for this session (oldest first). */
  async getAskAiMessages(userId: string, id: string) {
    const record = await this.findWithAskAi(userId, id);
    return { messages: record.askAiMessages ?? [] };
  }

  /**
   * Answers a free-form question about this interview prep. The AI is given
   * the job, the question list, and - when `focusIndex` points at a question -
   * that question and its model answer, so "ask about this question" gets a
   * specific, in-depth reply. Both sides of the exchange are saved so the
   * thread survives a refresh.
   */
  async askAi(userId: string, id: string, dto: AskAiDto) {
    const record = await this.findWithAskAi(userId, id);

    const questions = record.questions ?? [];
    const focusIndex = dto.focusIndex ?? null;
    if (focusIndex !== null && (focusIndex < 0 || focusIndex >= questions.length)) {
      throw new BadRequestException('That question does not exist in this interview prep.');
    }

    const list = questions
      .slice(0, 20)
      .map((q, i) => `${i + 1}. [${q.category}] ${q.question}`)
      .join('\n');
    const summary =
      `Interview preparation for the role: ${record.jobTitle}\n` +
      `Job description: ${(record.jobDescription || '').slice(0, 2500)}\n` +
      (record.jobRequirements ? `Requirements: ${record.jobRequirements.slice(0, 1200)}\n` : '') +
      `Practice questions in this session:\n${list}`;
    const focusQ = focusIndex !== null ? questions[focusIndex] : undefined;
    const focus = focusQ
      ? `Question ${focusIndex! + 1} (${focusQ.category}): ${focusQ.question}\nModel answer: ${focusQ.idealAnswer}`
      : undefined;

    const history = (record.askAiMessages ?? [])
      .filter((m) => (m.focusIndex ?? null) === focusIndex)
      .map((m) => ({ role: m.role, content: m.content }));

    const answer = await this.gemini.askQuestion(userId, { kind: 'interview', summary, focus }, dto.question, history);

    // Two distinct timestamps, one per saved message - NOT the same `now`
    // reused twice. The response below must echo back each message's own
    // true stored createdAt, or a later "read this message aloud" request
    // (which looks a message up by exact createdAt) can resolve to the
    // wrong one. That was the bug: the response used to return the
    // question's timestamp for both, so "listen to the answer" ended up
    // looking up (and reading back) the question instead.
    const questionCreatedAt = new Date();
    const answerCreatedAt = new Date();
    // Atomic append (row-locked), keeping only the newest ASK_AI_MAX_STORED_MESSAGES - the old `$push` + `$slice`.
    await updateLockedRow<{ askAiMessages: any[] | null }>(
      this.dataSource,
      InterviewPrep,
      { id: record.id, userId },
      ['askAiMessages'],
      (row) => ({
        askAiMessages: appendKeepingLast(
          row.askAiMessages,
          [
            { role: 'user', content: dto.question, focusIndex, createdAt: questionCreatedAt },
            { role: 'assistant', content: answer, focusIndex, createdAt: answerCreatedAt },
          ],
          ASK_AI_MAX_STORED_MESSAGES,
        ),
      }),
    );

    return { question: dto.question, answer, focusIndex, questionCreatedAt, answerCreatedAt };
  }

  async clearAskAi(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    await updateLockedRow(this.dataSource, InterviewPrep, { id: record.id, userId }, [], () => ({ askAiMessages: [] }));
    return { cleared: true };
  }

  /**
   * Reads one saved Ask AI message aloud - either side of the exchange, the
   * UI offers a "listen" button on both the question and the answer.
   * Messages have no separate id, so this is matched by its stored
   * createdAt timestamp plus role: createdAt alone isn't quite enough to
   * guarantee finding the right one (a question and its answer are saved a
   * few milliseconds apart, but if a caller ever passes back the wrong
   * timestamp - which is exactly what used to happen - matching on role too
   * stops that from silently resolving to the other message).
   */
  async getAskAiMessageAudio(
    req: Request,
    res: Response,
    userId: string,
    id: string,
    createdAtMs: number,
    role: 'user' | 'assistant' | undefined,
    voice: string | undefined,
  ): Promise<void> {
    const record = await this.findWithAskAi(userId, id);
    const message = (record.askAiMessages ?? []).find(
      (m) => new Date(m.createdAt).getTime() === createdAtMs && (!role || m.role === role),
    );
    if (!message) throw new NotFoundException('That message was not found.');
    // The role is folded into the cache key (not just id+timestamp) so any
    // audio wrongly cached under the old, ambiguous key - from before this
    // fix - is never reused; this request naturally regenerates fresh,
    // correct audio instead of serving a stale wrong-message clip.
    await this.audio.serveAudio(req, res, 'ask-ai-message', `${record.id}:${createdAtMs}:${message.role}`, message.content, voice);
  }

  /**
   * Speech-to-text for the Ask AI voice-input mic. Transcribes only - it
   * doesn't grade, save, or ask anything on its own - so the learner can
   * review/edit the recognized text in the question box before sending it,
   * same as if they had typed it.
   */
  async transcribeAskAiVoice(userId: string, id: string, audio: Express.Multer.File): Promise<{ text: string }> {
    await this.findOne(userId, id); // ownership check; also 404s a bad id early
    if (!audio?.buffer?.length) throw new BadRequestException('No audio was uploaded.');
    const text = await this.gemini.transcribeAudio(userId, {
      base64: audio.buffer.toString('base64'),
      mimeType: audio.mimetype,
    });
    return { text };
  }
}
