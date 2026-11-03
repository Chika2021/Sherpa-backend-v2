import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Request, Response } from 'express';
import { SkillTutorial, SkillCbtAnswer, SkillLabAttempt } from '../entities/skill-tutorial.entity';
import { GeminiService } from '../ai/gemini.service';
import { MODULE_HARD_FLOOR_WORDS, countProseWords } from '../ai/tutorial-depth';
import { StorageService } from '../storage/storage.service';
import { AudioService } from '../audio/audio.service';
import { SkillTutorialPdfService } from './skill-tutorial-pdf.service';
import { CreateSkillTutorialDto } from './dto/create-skill-tutorial.dto';
import { AnswerSkillCbtQuestionDto } from './dto/answer-skill-cbt-question.dto';
import { SubmitLabAttemptDto } from './dto/submit-lab-attempt.dto';
import { assertValidId, ownedBy } from '../database/db-utils';
import { appendKeepingLast, updateLockedRow } from '../database/locked-row.util';
import { AskAiDto } from '../common/dto/ask-ai.dto';
import { splitLessonIntoSections } from '../common/lesson-sections.util';
import { ASK_AI_MAX_STORED_MESSAGES } from '../common/ask-ai.types';

// Average adult speaking pace, used only to give the voice-tutor UI a
// progress estimate per module - not exact, just enough to show "~2 min".
const NARRATION_WORDS_PER_MINUTE = 150;

@Injectable()
export class SkillsService {
  constructor(
    @InjectRepository(SkillTutorial) private tutorials: Repository<SkillTutorial>,
    @InjectDataSource() private dataSource: DataSource,
    private gemini: GeminiService,
    private storage: StorageService,
    private pdf: SkillTutorialPdfService,
    private audio: AudioService,
  ) {}

  /** Generates a complete tutorial for a user-typed skill/course name and saves it. */
  async create(userId: string, dto: CreateSkillTutorialDto) {
    const tutorial = await this.gemini.generateSkillTutorial(userId, dto.skillName, dto.level ?? 'Beginner');

    if (!tutorial.modules.length) {
      throw new BadRequestException('The AI did not return a tutorial. Please try again.');
    }

    assertValidId(userId, 'User');
    return this.tutorials.save(
      this.tutorials.create({
        userId,
        title: tutorial.title,
        level: tutorial.level,
        overview: tutorial.overview,
        estimatedMinutes: tutorial.estimatedMinutes,
        modules: tutorial.modules,
        courseGuide: tutorial.courseGuide, // undefined (older flow / guide call failed) is simply not stored
      }),
    );
  }

  findAllForUser(userId: string) {
    assertValidId(userId, 'User');
    return this.tutorials.find({
      where: { userId },
      select: {
        id: true,
        title: true,
        level: true,
        overview: true,
        estimatedMinutes: true,
        cbtCompleted: true,
        cbtQuestions: true,
        labExercises: true,
        createdAt: true,
      },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string): Promise<SkillTutorial> {
    const record = await this.tutorials.findOneBy(ownedBy(id, userId, 'Skill tutorial'));
    if (!record) throw new NotFoundException('Skill tutorial not found');
    return record;
  }

  /** Same as findOne, but also loads the (normally hidden) saved Ask AI conversation. */
  private async findWithAskAi(userId: string, id: string): Promise<SkillTutorial> {
    const record = await this.tutorials
      .createQueryBuilder('t')
      .addSelect('t.askAiMessages')
      .where('t.id = :id AND t.userId = :userId', ownedBy(id, userId, 'Skill tutorial'))
      .getOne();
    if (!record) throw new NotFoundException('Skill tutorial not found');
    return record;
  }

  async remove(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    await this.tutorials.delete({ id: record.id });
    return { deleted: true };
  }

  // ---- Voice tutor narration ----
  // The tutorial's modules are written to be read aloud as-is (see
  // generateSkillTutorial's prompt). getNarration hands the client clean,
  // ordered text - both the short spoken `narration` AND the full
  // `detailedMaterial` lesson - plus rough spoken-duration estimates per
  // module to drive a play/pause/progress UI; getNarrationAudio actually
  // synthesizes and streams real speech for one module (or the whole
  // tutorial) via AudioService, in whichever of the app's voices the
  // learner picked, and for whichever of the two texts (`variant`) they
  // want read to them.

  async getNarration(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    const modules = record.modules.map((module, index) => ({
      moduleIndex: index,
      heading: module.heading,
      narration: module.narration,
      detailedMaterial: module.detailedMaterial ?? '',
      keyPoints: module.keyPoints ?? [],
      example: module.example,
      estimatedSeconds: this.estimateNarrationSeconds(module.narration),
      materialEstimatedSeconds: this.estimateNarrationSeconds(module.detailedMaterial ?? ''),
      // The lesson's "##" headings. The voice tutor reads ONE of these per request
      // (?variant=material&moduleIndex=M&sectionIndex=S), so nothing is synthesized
      // until the learner actually plays that heading.
      sections: splitLessonIntoSections(module.detailedMaterial).map((section) => ({
        sectionIndex: section.sectionIndex,
        title: section.title,
        estimatedSeconds: this.estimateNarrationSeconds(section.markdown),
      })),
    }));

    return {
      skillTutorialId: record.id,
      title: record.title,
      overview: record.overview,
      totalEstimatedSeconds: modules.reduce((sum, m) => sum + m.estimatedSeconds, 0),
      totalMaterialEstimatedSeconds: modules.reduce((sum, m) => sum + m.materialEstimatedSeconds, 0),
      voices: this.audio.getAvailableVoices(),
      modules,
    };
  }

  /** The set of Gemini voices the learner can pick for the voice tutor. */
  getAvailableVoices() {
    return this.audio.getAvailableVoices();
  }

  /**
   * Streams real synthesized speech for this tutorial's narration straight
   * to the response. `moduleIndex` omitted reads the whole tutorial
   * (overview + every module, in order); given, reads just that module.
   * `variant` picks WHICH text gets read: 'narration' (default) is the
   * short spoken summary, 'material' is the full detailedMaterial lesson
   * (markdown stripped for speech - see stripMarkdownForSpeech). `voice`
   * picks which of getAvailableVoices() reads it - the same (module,
   * variant) cached in two different voices are two different cache
   * entries, so switching voices is always genuinely different audio, not
   * a relabeled replay.
   */
  async getNarrationAudio(
    req: Request,
    res: Response,
    userId: string,
    id: string,
    moduleIndex: number | undefined,
    voice: string | undefined,
    variant: 'narration' | 'material' = 'narration',
    sectionIndex?: number,
  ): Promise<void> {
    const record = await this.findOne(userId, id);

    // The full lesson text is NEVER synthesized in one go - that is what used to burn the whole
    // free Gemini TTS allowance before the learner had listened to anything. Material is read
    // one "##" heading at a time; the player asks for the next heading only when the learner
    // reaches it (or finishes this one).
    if (variant === 'material') {
      if (moduleIndex === undefined) {
        throw new BadRequestException('Choose a topic (moduleIndex) and a heading (sectionIndex) to read aloud.');
      }
      const module = record.modules[moduleIndex];
      if (!module) throw new BadRequestException('Invalid module index.');
      const sections = splitLessonIntoSections(module.detailedMaterial);
      if (!sections.length) {
        throw new BadRequestException('This module has no detailed material to read aloud yet.');
      }
      const wanted = sectionIndex ?? 0;
      const section = sections[wanted];
      if (!Number.isInteger(wanted) || !section) {
        throw new BadRequestException(`Invalid heading. This topic has ${sections.length} headings (0-${sections.length - 1}).`);
      }
      res.set({
        'X-Audio-Section': String(wanted),
        'X-Audio-Section-Count': String(sections.length),
        'X-Audio-Section-Title': encodeURIComponent(section.title),
        'Access-Control-Expose-Headers': 'X-Audio-Section, X-Audio-Section-Count, X-Audio-Section-Title',
      });
      await this.audio.serveAudio(
        req,
        res,
        'skill-section-material',
        `${record.id}:${moduleIndex}:${wanted}`,
        section.markdown,
        voice,
      );
      return;
    }

    // Short spoken narration (a few sentences per module) is cheap, so it is unchanged.
    if (moduleIndex === undefined) {
      const text = [record.overview, ...record.modules.map((m) => m.narration)].filter(Boolean).join(' ');
      await this.audio.serveAudio(req, res, 'skill-full', record.id, text, voice);
      return;
    }

    const module = record.modules[moduleIndex];
    if (!module) throw new BadRequestException('Invalid module index.');
    await this.audio.serveAudio(req, res, 'skill-module', `${record.id}:${moduleIndex}`, module.narration, voice);
  }

  /**
   * Brings a tutorial's modules up to full depth: backfills detailedMaterial
   * for any module that doesn't have it yet (tutorials generated before this
   * field existed), AND rewrites any module whose lesson is too short to
   * print to the minimum page count (tutorials generated before the
   * 4-pages-per-module rule) - or, if `regenerateAll` is true, rewrites every
   * module. heading/narration/keyPoints/example are left untouched either
   * way, so any CBT questions or lab exercises already generated from this
   * tutorial stay valid. A module that can't be rewritten keeps the lesson it
   * already had.
   */
  async generateMaterial(userId: string, id: string, regenerateAll = false) {
    const record = await this.findOne(userId, id);
    const needsWork = (m: { detailedMaterial?: string }) =>
      regenerateAll || !m.detailedMaterial || countProseWords(m.detailedMaterial) < MODULE_HARD_FLOOR_WORDS;
    const targets = record.modules.filter(needsWork);

    if (targets.length) {
      const materials = await this.gemini.generateModuleMaterials(
        userId,
        { title: record.title, level: record.level, overview: record.overview },
        targets,
        record.modules.map((m) => ({ tier: m.tier, heading: m.heading })),
      );
      let cursor = 0;
      record.modules = record.modules.map((m) =>
        needsWork(m) ? { ...m, detailedMaterial: materials[cursor++] || m.detailedMaterial } : m,
      );
      // The downloadable PDF is cached (see downloadTutorial) - invalidate
      // it so the next download reflects the newly (re)generated material
      // instead of silently serving a stale file forever.
      record.tutorialFilePath = null; // null (not undefined) - that is what actually clears the column
      await this.tutorials.save(record);
    }

    return this.getNarration(userId, id);
  }

  private estimateNarrationSeconds(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(5, Math.round((words / NARRATION_WORDS_PER_MINUTE) * 60));
  }

  // ---- Downloadable tutorial (PDF) ----

  /** Renders (or reuses a cached render of) the tutorial as a PDF and returns its download URL. */
  async downloadTutorial(userId: string, id: string) {
    const record = await this.findOne(userId, id);

    if (!record.tutorialFilePath) {
      const { buffer } = await this.pdf.renderWithStats({
        title: record.title,
        level: record.level,
        overview: record.overview,
        estimatedMinutes: record.estimatedMinutes,
        modules: record.modules,
        courseGuide: record.courseGuide ?? undefined,
      });
      const safeSlug = record.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      record.tutorialFilePath = this.storage.writeGeneratedFile(
        userId,
        `skill-tutorial-${safeSlug}-${record.id}.pdf`,
        buffer,
      );
      await this.tutorials.save(record);
    }

    return { url: this.storage.publicUrlFor(record.tutorialFilePath) };
  }

  // ---- CBT (multiple-choice practice quiz) ----
  // Same withholding/scoring pattern as InterviewPrepService's CBT: wrong
  // answers show the correction (correctOptionIndex + explanation) before
  // the client advances to the next question.

  /** Generates (or regenerates) the CBT quiz from this tutorial, resetting progress. */
  async generateCbt(userId: string, id: string) {
    const record = await this.findOne(userId, id);

    const cbtQuestions = await this.gemini.generateSkillCbtQuestions(userId, {
      title: record.title,
      level: record.level,
      overview: record.overview,
      estimatedMinutes: record.estimatedMinutes,
      modules: record.modules,
    });
    if (!cbtQuestions.length) {
      throw new BadRequestException('The AI did not return any CBT questions. Please try again.');
    }

    record.cbtQuestions = cbtQuestions;
    record.cbtAnswers = [];
    record.cbtCompleted = false;
    await this.tutorials.save(record);

    return this.getCbt(userId, id);
  }

  /**
   * Returns the CBT quiz state with answers withheld for questions the user
   * hasn't submitted yet, so taking it client-side behaves like a real quiz.
   */
  async getCbt(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    if (!record.cbtQuestions?.length) {
      throw new NotFoundException('No CBT has been generated for this tutorial yet.');
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
      skillTutorialId: record.id,
      totalQuestions: record.cbtQuestions.length,
      answeredCount: record.cbtAnswers.length,
      score,
      completed: record.cbtCompleted,
      questions,
    };
  }

  /** Grades one answer, returning the correction (right answer + explanation) to show before advancing. */
  async answerCbtQuestion(userId: string, id: string, dto: AnswerSkillCbtQuestionDto) {
    const record = await this.findOne(userId, id);
    const cbtQuestions = record.cbtQuestions;
    if (!cbtQuestions?.length) {
      throw new NotFoundException('No CBT has been generated for this tutorial yet.');
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
        ...this.cbtProgress(record),
      };
    }

    const correct = dto.selectedOptionIndex === question.correctOptionIndex;
    const answer: SkillCbtAnswer = { questionIndex: dto.questionIndex, selectedOptionIndex: dto.selectedOptionIndex, correct };
    record.cbtAnswers.push(answer);
    if (record.cbtAnswers.length >= cbtQuestions.length) record.cbtCompleted = true;
    await this.tutorials.save(record);

    return {
      questionIndex: dto.questionIndex,
      selectedOptionIndex: dto.selectedOptionIndex,
      correct,
      // Sent back regardless of right/wrong so the client can always show
      // "why" - it's the wrong-answer case where the caller actually needs
      // to display this before moving to the next question.
      correctOptionIndex: question.correctOptionIndex,
      explanation: question.explanation,
      ...this.cbtProgress(record),
    };
  }

  /** Clears progress on the current CBT quiz (same questions) so the user can retake it. */
  async restartCbt(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    if (!record.cbtQuestions?.length) {
      throw new NotFoundException('No CBT has been generated for this tutorial yet.');
    }
    record.cbtAnswers = [];
    record.cbtCompleted = false;
    await this.tutorials.save(record);
    return this.getCbt(userId, id);
  }

  private cbtProgress(record: SkillTutorial) {
    return {
      answeredCount: record.cbtAnswers.length,
      totalQuestions: record.cbtQuestions?.length ?? 0,
      score: record.cbtAnswers.filter((a) => a.correct).length,
      completed: record.cbtCompleted,
    };
  }

  // ---- Lab (real-time hands-on practice) ----
  // Unlike the CBT, exercises can be re-attempted any number of times - the
  // point is real-time iterative practice, not a one-shot test, so every
  // attempt is graded and returned immediately with a model solution to
  // learn from rather than locking after the first try.

  /** Generates (or regenerates) the lab's practice exercises from this tutorial. */
  async generateLab(userId: string, id: string) {
    const record = await this.findOne(userId, id);

    const labExercises = await this.gemini.generateLabExercises(userId, {
      title: record.title,
      level: record.level,
      overview: record.overview,
      estimatedMinutes: record.estimatedMinutes,
      modules: record.modules,
    });
    if (!labExercises.length) {
      throw new BadRequestException('The AI did not return any lab exercises. Please try again.');
    }

    record.labExercises = labExercises;
    record.labAttempts = [];
    await this.tutorials.save(record);

    return this.getLab(userId, id);
  }

  /**
   * Current lab state: every exercise with its instructions and hint always
   * visible, plus (once attempted at least once) that exercise's latest
   * attempt result and model solution to learn from.
   */
  async getLab(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    if (!record.labExercises?.length) {
      throw new NotFoundException('No lab has been generated for this tutorial yet.');
    }

    const latestByExercise = new Map<number, SkillLabAttempt>();
    for (const attempt of record.labAttempts) {
      latestByExercise.set(attempt.exerciseIndex, attempt); // attempts are stored in order, so last wins
    }
    const attemptCounts = new Map<number, number>();
    for (const attempt of record.labAttempts) {
      attemptCounts.set(attempt.exerciseIndex, (attemptCounts.get(attempt.exerciseIndex) ?? 0) + 1);
    }

    const exercises = record.labExercises.map((exercise, index) => {
      const latest = latestByExercise.get(index);
      return {
        exerciseIndex: index,
        title: exercise.title,
        instructions: exercise.instructions,
        hint: exercise.hint,
        starterTemplate: exercise.starterTemplate,
        starterFileName: exercise.starterFileName,
        attemptCount: attemptCounts.get(index) ?? 0,
        ...(latest
          ? {
              lastSubmission: latest.submission,
              correct: latest.correct,
              score: latest.score,
              feedback: latest.feedback,
              modelSolution: exercise.modelSolution,
            }
          : {}),
      };
    });

    return {
      skillTutorialId: record.id,
      totalExercises: record.labExercises.length,
      exercises,
    };
  }

  /** Grades one lab attempt in real time and records it; the exercise can be re-attempted afterward. */
  async submitLabAttempt(userId: string, id: string, dto: SubmitLabAttemptDto) {
    const record = await this.findOne(userId, id);
    const exercise = record.labExercises?.[dto.exerciseIndex];
    if (!exercise) throw new BadRequestException('Invalid exercise index.');

    const evaluation = await this.gemini.evaluateLabAttempt(userId, record.title, exercise, dto.submission);

    const attempt: SkillLabAttempt = {
      exerciseIndex: dto.exerciseIndex,
      submission: dto.submission,
      correct: evaluation.correct,
      score: evaluation.score,
      feedback: evaluation.feedback,
      attemptedAt: new Date(),
    };
    record.labAttempts.push(attempt);
    await this.tutorials.save(record);

    const priorAttempts = record.labAttempts.filter((a) => a.exerciseIndex === dto.exerciseIndex).length;

    return {
      exerciseIndex: dto.exerciseIndex,
      correct: evaluation.correct,
      score: evaluation.score,
      feedback: evaluation.feedback,
      modelSolution: exercise.modelSolution,
      attemptCount: priorAttempts,
    };
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
    await this.audio.serveAudio(req, res, 'skill-cbt-question', `${record.id}:${questionIndex}`, question.question, voice);
  }

  /**
   * Reads the correct answer + explanation aloud - but only once the user
   * has actually answered this question (see getCbt(), which withholds the
   * same fields for the same reason - this check stops that from being
   * bypassed via the audio endpoint).
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
    await this.audio.serveAudio(req, res, 'skill-cbt-answer', `${record.id}:${questionIndex}`, text, voice);
  }

  // ---- Ask AI ----

  /** The saved "Ask AI" conversation for this course (oldest first). */
  async getAskAiMessages(userId: string, id: string) {
    const record = await this.findWithAskAi(userId, id);
    return { messages: record.askAiMessages ?? [] };
  }

  /**
   * Answers a free-form question about this course. The AI is given the
   * course outline and - when `focusIndex` points at a module - that
   * module's lesson text, so a question asked from inside a module gets an
   * answer grounded in what the learner is actually reading. Both sides of
   * the exchange are saved so the thread survives a refresh.
   */
  async askAi(userId: string, id: string, dto: AskAiDto) {
    const record = await this.findWithAskAi(userId, id);

    const modules = record.modules ?? [];
    const focusIndex = dto.focusIndex ?? null;
    if (focusIndex !== null && (focusIndex < 0 || focusIndex >= modules.length)) {
      throw new BadRequestException('That module does not exist in this course.');
    }

    const outline = modules.map((m, i) => `${i + 1}. ${m.heading}${m.tier ? ` (${m.tier})` : ''}`).join('\n');
    const summary =
      `Course: ${record.title} (level: ${record.level})\n` +
      `Overview: ${(record.overview || '').slice(0, 1500)}\n` +
      `Modules:\n${outline}`;
    const focusM = focusIndex !== null ? modules[focusIndex] : undefined;
    const focus = focusM
      ? `Module ${focusIndex! + 1}: ${focusM.heading}\n` +
        `Key points: ${(focusM.keyPoints ?? []).join('; ')}\n` +
        `Lesson text:\n${(focusM.detailedMaterial || focusM.narration || '').slice(0, 30000)}`
      : undefined;

    const history = (record.askAiMessages ?? [])
      .filter((m) => (m.focusIndex ?? null) === focusIndex)
      .map((m) => ({ role: m.role, content: m.content }));

    const answer = await this.gemini.askQuestion(userId, { kind: 'course', summary, focus }, dto.question, history);

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
      SkillTutorial,
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
    await updateLockedRow(this.dataSource, SkillTutorial, { id: record.id, userId }, [], () => ({ askAiMessages: [] }));
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