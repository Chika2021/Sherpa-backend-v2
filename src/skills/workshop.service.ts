import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import type { Request, Response } from 'express';
import { User } from '../entities/user.entity';
import { AudioService } from '../audio/audio.service';
import {
  loraFeedbackScript,
  loraFinishScript,
  loraIntroScript,
  loraStepScript,
  loraUnitScript,
} from './lora-internship.scripts';
import { SkillTutorial, WorkshopAttempt, WorkshopChatMessage } from '../entities/skill-tutorial.entity';
import { GeminiService } from '../ai/gemini.service';
import { WORKSHOP_PASS_SCORE, WorkshopPlan, WorkshopStep, WorkshopUnit } from '../ai/workshop.prompts';
import { ownedBy } from '../database/db-utils';
import { appendKeepingLast, updateLockedRow } from '../database/locked-row.util';

const MAX_STORED_CHAT_MESSAGES = 150;

export type StepStatus = 'locked' | 'current' | 'passed';
export type UnitStatus = 'locked' | 'available' | 'in_progress' | 'completed';

interface StepProgress {
  status: StepStatus;
  attemptCount: number;
  bestScore: number | null;
  lastScore: number | null;
  lastFeedback?: string;
  lastSubmission?: string;
  lastCorrections?: WorkshopAttempt['corrections'];
}

/**
 * The AI Internship (code name: workshop): a practical programme on top of a skill
 * course. Levels (Beginner -> Super Advanced) come first; once every level is
 * passed the real-world projects open, one after another.
 *
 * Rules live here, not in the model:
 *  - steps unlock one at a time - a step opens when the one before it is passed;
 *  - a unit opens when the unit before it is completed (projects need ALL levels done);
 *  - a submission passes at WORKSHOP_PASS_SCORE or above, and can be retried forever;
 *  - progress is derived from the append-only attempts list, so it can never drift from it.
 */
@Injectable()
export class WorkshopService {
  constructor(
    @InjectRepository(SkillTutorial) private tutorials: Repository<SkillTutorial>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectDataSource() private dataSource: DataSource,
    private gemini: GeminiService,
    private audio: AudioService,
  ) {}

  // ---- loading ----

  private async load(userId: string, id: string, withChat = false): Promise<SkillTutorial> {
    // workshop / attempts / chat are `select: false` columns, so they're added explicitly.
    const qb = this.tutorials
      .createQueryBuilder('t')
      .addSelect('t.workshop')
      .addSelect('t.workshopAttempts')
      .where('t.id = :id AND t.userId = :userId', ownedBy(id, userId, 'Skill tutorial'));
    if (withChat) qb.addSelect('t.workshopChat');
    const record = await qb.getOne();
    if (!record) throw new NotFoundException('Skill tutorial not found');
    return record;
  }

  private requirePlan(record: SkillTutorial): WorkshopPlan {
    if (!record.workshop?.units?.length) {
      throw new NotFoundException('The internship has not been created for this course yet.');
    }
    return record.workshop;
  }

  private requireUnit(plan: WorkshopPlan, unitId: string): { unit: WorkshopUnit; unitIndex: number } {
    const unitIndex = plan.units.findIndex((u) => u.id === unitId);
    if (unitIndex === -1) throw new NotFoundException('That internship section does not exist.');
    return { unit: plan.units[unitIndex], unitIndex };
  }

  // ---- progress (derived from attempts) ----

  private stepProgress(unit: WorkshopUnit, attempts: WorkshopAttempt[]): StepProgress[] {
    const mine = attempts.filter((a) => a.unitId === unit.id);
    const total = unit.steps?.length ?? unit.outline.length;
    const result: StepProgress[] = [];
    let previousPassed = true;

    for (let i = 0; i < total; i++) {
      const forStep = mine.filter((a) => a.stepIndex === i);
      const last = forStep[forStep.length - 1];
      const passed = forStep.some((a) => a.passed);
      const status: StepStatus = passed ? 'passed' : previousPassed && unit.steps ? 'current' : 'locked';
      result.push({
        status,
        attemptCount: forStep.length,
        bestScore: forStep.length ? Math.max(...forStep.map((a) => a.score)) : null,
        lastScore: last ? last.score : null,
        lastFeedback: last?.feedback,
        lastSubmission: last?.submission,
        lastCorrections: last?.corrections,
      });
      previousPassed = passed;
    }
    return result;
  }

  private unitStates(plan: WorkshopPlan, attempts: WorkshopAttempt[]) {
    let previousCompleted = true;
    let levelsAllCompleted = true;

    return plan.units.map((unit) => {
      const steps = this.stepProgress(unit, attempts);
      const passedCount = steps.filter((s) => s.status === 'passed').length;
      const completed = steps.length > 0 && passedCount === steps.length;
      // Levels open one after another; the first project also needs EVERY level done, later projects the project before.
      const unlocked = unit.kind === 'level' ? previousCompleted : previousCompleted && levelsAllCompleted;
      const status: UnitStatus = !unlocked ? 'locked' : completed ? 'completed' : passedCount > 0 || attempts.some((a) => a.unitId === unit.id) ? 'in_progress' : 'available';

      if (unit.kind === 'level') {
        levelsAllCompleted = levelsAllCompleted && completed;
        previousCompleted = completed;
      } else {
        previousCompleted = completed;
      }
      return { unit, steps, passedCount, completed, status };
    });
  }

  private summarize(plan: WorkshopPlan, attempts: WorkshopAttempt[]) {
    const states = this.unitStates(plan, attempts);
    const totalSteps = states.reduce((n, s) => n + s.steps.length, 0);
    const passedSteps = states.reduce((n, s) => n + s.passedCount, 0);
    const xp = states.reduce(
      (sum, s) => sum + s.steps.reduce((x, p) => x + (p.status === 'passed' ? Math.round(p.bestScore ?? 0) : 0), 0),
      0,
    );
    const levelStates = states.filter((s) => s.unit.kind === 'level');
    const projectStates = states.filter((s) => s.unit.kind === 'project');
    const nextUnit = states.find((s) => s.status === 'available' || s.status === 'in_progress');

    return {
      states,
      progress: {
        totalSteps,
        passedSteps,
        percent: totalSteps ? Math.round((passedSteps / totalSteps) * 100) : 0,
        xp,
        levelsCompleted: levelStates.filter((s) => s.completed).length,
        totalLevels: levelStates.length,
        projectsCompleted: projectStates.filter((s) => s.completed).length,
        totalProjects: projectStates.length,
        attempts: attempts.length,
        finished: states.length > 0 && states.every((s) => s.completed),
        nextUnitId: nextUnit?.unit.id ?? null,
      },
    };
  }

  // ---- public API ----

  /** The workshop's home screen: every level and project with its lock state and progress. */
  async getOverview(userId: string, id: string) {
    const record = await this.load(userId, id);
    if (!record.workshop?.units?.length) return { created: false as const };

    const plan = record.workshop;
    const { states, progress } = this.summarize(plan, record.workshopAttempts ?? []);

    return {
      created: true as const,
      skillTutorialId: record.id,
      title: plan.title,
      tagline: plan.tagline,
      passScore: WORKSHOP_PASS_SCORE,
      progress,
      levels: states.filter((s) => s.unit.kind === 'level').map((s) => this.unitCard(s)),
      projects: states.filter((s) => s.unit.kind === 'project').map((s) => this.unitCard(s)),
    };
  }

  private unitCard(s: { unit: WorkshopUnit; steps: StepProgress[]; passedCount: number; status: UnitStatus }) {
    const u = s.unit;
    return {
      unitId: u.id,
      kind: u.kind,
      tier: u.tier,
      title: u.title,
      summary: u.summary,
      outcomes: u.outcomes,
      status: s.status,
      stepsGenerated: !!u.steps?.length,
      totalSteps: u.outline.length,
      passedSteps: s.passedCount,
      outline: u.outline,
      ...(u.kind === 'project'
        ? { role: u.role, scenario: u.scenario, deliverables: u.deliverables, techStack: u.techStack, milestones: u.milestones }
        : {}),
    };
  }

  /** Designs the workshop (outline of all levels + projects). Idempotent unless `restart`; costs 1 token when it generates. */
  async create(userId: string, id: string, restart = false) {
    const record = await this.load(userId, id);
    if (record.workshop?.units?.length && !restart) return this.getOverview(userId, id);

    const plan = await this.gemini.generateWorkshopPlan(userId, {
      title: record.title,
      level: record.level,
      overview: record.overview,
      modules: record.modules,
    });

    await updateLockedRow(this.dataSource, SkillTutorial, { id: record.id, userId }, [], () => ({
      workshop: plan,
      workshopAttempts: [],
      workshopChat: [],
    }));
    return this.getOverview(userId, id);
  }

  /**
   * One level or project in full: its briefing, every step (once started) and
   * the learner's progress on each. Locked units show only their outline.
   */
  async getUnit(userId: string, id: string, unitId: string) {
    const record = await this.load(userId, id);
    const plan = this.requirePlan(record);
    const { unit } = this.requireUnit(plan, unitId);
    const attempts = record.workshopAttempts ?? [];
    const state = this.unitStates(plan, attempts).find((s) => s.unit.id === unitId)!;

    const card = this.unitCard(state);
    if (state.status === 'locked') {
      return { ...card, locked: true, lockedReason: this.lockedReason(unit), steps: [] };
    }

    const steps = (unit.steps ?? []).map((step, index) => {
      const p = state.steps[index];
      const unlocked = p.status !== 'locked';
      // A locked step shows only its title and phase, so the learner works through the guide in order rather than skipping ahead.
      if (!unlocked) {
        return { stepIndex: index, title: step.title, phase: step.phase, status: p.status };
      }
      return {
        stepIndex: index,
        status: p.status,
        ...step,
        attemptCount: p.attemptCount,
        bestScore: p.bestScore,
        lastScore: p.lastScore,
        lastFeedback: p.lastFeedback,
        lastSubmission: p.lastSubmission,
        lastCorrections: p.lastCorrections,
      };
    });

    return { ...card, locked: false, steps };
  }

  private lockedReason(unit: WorkshopUnit): string {
    if (unit.kind === 'level') return 'Complete the previous level to unlock this one.';
    return unit.id === 'P1'
      ? 'Finish every practical level to unlock the projects.'
      : 'Complete the previous project to unlock this one.';
  }

  /**
   * Starts a level/project: has the AI write its complete step-by-step guide
   * (what to do, the code/artifact to put in, why, and what it does). Idempotent -
   * a unit that already has its steps is returned as-is without charging.
   */
  async startUnit(userId: string, id: string, unitId: string) {
    const record = await this.load(userId, id);
    const plan = this.requirePlan(record);
    const { unit, unitIndex } = this.requireUnit(plan, unitId);
    const attempts = record.workshopAttempts ?? [];
    const states = this.unitStates(plan, attempts);

    if (states[unitIndex].status === 'locked') throw new ForbiddenException(this.lockedReason(unit));

    if (!unit.steps?.length) {
      const completedUnitTitles = states.filter((s) => s.completed).map((s) => s.unit.title);
      const steps = await this.gemini.generateWorkshopUnit(userId, {
        courseTitle: record.title,
        courseLevel: record.level,
        courseOverview: record.overview,
        unit,
        completedUnitTitles,
      });

      // Only the first writer wins, so two quick taps on "Start" can't overwrite steps the learner has already begun.
      await updateLockedRow<{ workshop: any }>(
        this.dataSource,
        SkillTutorial,
        { id: record.id, userId },
        ['workshop'],
        (row) => {
          const target = row.workshop?.units?.[unitIndex];
          if (!target || target.steps !== undefined) return null; // someone else already wrote this unit's steps
          target.steps = steps;
          target.generatedAt = new Date().toISOString();
          return { workshop: row.workshop };
        },
      );
    }
    return this.getUnit(userId, id, unitId);
  }

  /** Reviews one checkpoint submission. Pass = score >= WORKSHOP_PASS_SCORE; unlimited retries. */
  async submitStep(userId: string, id: string, unitId: string, stepIndex: number, submission: string) {
    const record = await this.load(userId, id);
    const plan = this.requirePlan(record);
    const { unit, unitIndex } = this.requireUnit(plan, unitId);
    const attempts = record.workshopAttempts ?? [];
    const states = this.unitStates(plan, attempts);
    const state = states[unitIndex];

    if (state.status === 'locked') throw new ForbiddenException(this.lockedReason(unit));
    const step = this.requireStep(unit, stepIndex);
    const progress = state.steps[stepIndex];
    if (progress.status === 'locked') throw new ForbiddenException('Pass the previous step first - each step builds on the one before it.');

    const wasPassed = progress.status === 'passed';
    const review = await this.gemini.reviewWorkshopStep(userId, {
      courseTitle: record.title,
      unitTitle: unit.title,
      unitKind: unit.kind,
      tier: unit.tier,
      step,
      submission,
      attemptNumber: progress.attemptCount + 1,
      previousFeedback: progress.lastFeedback,
    });
    const passed = review.score >= WORKSHOP_PASS_SCORE;

    const attempt: WorkshopAttempt = {
      unitId,
      stepIndex,
      submission,
      score: review.score,
      passed,
      feedback: review.feedback,
      wentWell: review.wentWell,
      toFix: review.toFix,
      corrections: review.corrections,
      nextTip: review.nextTip,
      attemptedAt: new Date(),
    };
    await updateLockedRow<{ workshopAttempts: any[] | null }>(
      this.dataSource,
      SkillTutorial,
      { id: record.id, userId },
      ['workshopAttempts'],
      (row) => ({ workshopAttempts: [...(row.workshopAttempts ?? []), attempt] }),
    );

    const after = this.summarize(plan, [...attempts, attempt]);
    const afterUnit = after.states[unitIndex];
    const total = afterUnit.steps.length;

    return {
      unitId,
      stepIndex,
      passed,
      score: review.score,
      feedback: review.feedback,
      wentWell: review.wentWell,
      toFix: review.toFix,
      corrections: review.corrections,
      nextTip: review.nextTip,
      attemptCount: progress.attemptCount + 1,
      passScore: WORKSHOP_PASS_SCORE,
      // Re-submitting an already-passed step is allowed (practice) but doesn't "unlock" anything new.
      newlyPassed: passed && !wasPassed,
      nextStepIndex: passed && !wasPassed && stepIndex + 1 < total ? stepIndex + 1 : null,
      unitCompleted: afterUnit.completed,
      unitStatus: afterUnit.status,
      unlockedUnitId: this.newlyUnlockedUnit(states, after.states),
      progress: after.progress,
    };
  }

  private newlyUnlockedUnit(
    before: Array<{ unit: WorkshopUnit; status: UnitStatus }>,
    after: Array<{ unit: WorkshopUnit; status: UnitStatus }>,
  ): string | null {
    const opened = after.find((a, i) => before[i].status === 'locked' && a.status !== 'locked');
    return opened?.unit.id ?? null;
  }

  private requireStep(unit: WorkshopUnit, stepIndex: number): WorkshopStep {
    if (!unit.steps?.length) throw new BadRequestException('Start this section first - its steps have not been written yet.');
    const step = unit.steps[stepIndex];
    if (!step) throw new BadRequestException('That step does not exist.');
    return step;
  }

  // ---- AI supervisor chat ----

  async getMentorChat(userId: string, id: string, unitId: string, stepIndex: number) {
    const record = await this.load(userId, id, true);
    const plan = this.requirePlan(record);
    this.requireUnit(plan, unitId);
    const messages = (record.workshopChat ?? []).filter((m) => m.unitId === unitId && m.stepIndex === stepIndex);
    return { messages };
  }

  /** Ask the AI supervisor about the step you're on. Only unlocked steps can be asked about. */
  async askMentor(userId: string, id: string, unitId: string, stepIndex: number, question: string) {
    const record = await this.load(userId, id, true);
    const plan = this.requirePlan(record);
    const { unit, unitIndex } = this.requireUnit(plan, unitId);
    const attempts = record.workshopAttempts ?? [];
    const state = this.unitStates(plan, attempts)[unitIndex];

    if (state.status === 'locked') throw new ForbiddenException(this.lockedReason(unit));
    const step = this.requireStep(unit, stepIndex);
    const progress = state.steps[stepIndex];
    if (progress.status === 'locked') throw new ForbiddenException('That step is still locked.');

    const history = (record.workshopChat ?? [])
      .filter((m) => m.unitId === unitId && m.stepIndex === stepIndex)
      .map((m) => ({ role: m.role, content: m.content }));

    const answer = await this.gemini.workshopMentorReply(
      userId,
      {
        courseTitle: record.title,
        unitTitle: unit.title,
        unitKind: unit.kind,
        tier: unit.tier,
        stepNumber: stepIndex + 1,
        totalSteps: unit.steps!.length,
        step,
        lastSubmission: progress.lastSubmission,
        lastFeedback: progress.lastFeedback,
      },
      question,
      history,
    );

    // Two distinct timestamps so each saved message keeps its own true createdAt.
    const questionAt = new Date();
    const answerAt = new Date(questionAt.getTime() + 1);
    const entries: WorkshopChatMessage[] = [
      { role: 'user', content: question, unitId, stepIndex, createdAt: questionAt },
      { role: 'assistant', content: answer, unitId, stepIndex, createdAt: answerAt },
    ];
    await updateLockedRow<{ workshopChat: any[] | null }>(
      this.dataSource,
      SkillTutorial,
      { id: record.id, userId },
      ['workshopChat'],
      (row) => ({ workshopChat: appendKeepingLast(row.workshopChat, entries, MAX_STORED_CHAT_MESSAGES) }),
    );

    return { question, answer, questionCreatedAt: questionAt, answerCreatedAt: answerAt };
  }

  async clearMentorChat(userId: string, id: string, unitId: string, stepIndex: number) {
    const record = await this.load(userId, id, true);
    const kept = (record.workshopChat ?? []).filter((m) => !(m.unitId === unitId && m.stepIndex === stepIndex));
    await updateLockedRow(this.dataSource, SkillTutorial, { id: record.id, userId }, [], () => ({ workshopChat: kept }));
    return { cleared: true };
  }

  // ---- completion (used by the internship document) ----

  /** Everything the internship document needs: the plan, the attempts and whether the learner has finished it all. */
  async completionSnapshot(userId: string, id: string) {
    const record = await this.load(userId, id);
    const plan = record.workshop?.units?.length ? record.workshop : null;
    const attempts = record.workshopAttempts ?? [];
    const summary = plan ? this.summarize(plan, attempts) : null;
    return { record, plan, attempts, summary, finished: !!summary?.progress.finished };
  }

  // ---- Lora's voice ----

  private async firstNameOf(userId: string): Promise<string | undefined> {
    const user = await this.users.findOne({ where: { id: userId }, select: { id: true, firstName: true } });
    return user?.firstName?.trim() || undefined;
  }

  /**
   * What Lora says for a given moment, as text. kinds:
   *   intro     - she introduces herself and explains the internship
   *   unit      - she briefs the level/project (needs unitId)
   *   step      - she teaches one step (needs unitId + stepIndex)
   *   feedback  - she reacts to the latest review of a step (needs unitId + stepIndex)
   *   mentor    - she reads one of her chat answers (needs unitId + stepIndex + createdAt)
   *   finish    - she congratulates the learner (unitId = a finished section, or omit for the whole internship)
   * Built from content that already exists, so it costs no token.
   */
  async loraText(
    userId: string,
    id: string,
    q: { kind: string; unitId?: string; stepIndex?: number; createdAt?: number },
  ): Promise<{ text: string; refId: string }> {
    const record = await this.load(userId, id, q.kind === 'mentor');
    const plan = this.requirePlan(record);
    const attempts = record.workshopAttempts ?? [];
    const firstName = await this.firstNameOf(userId);
    const base = `${record.id}:${q.kind}`;

    if (q.kind === 'intro') {
      const levels = plan.units.filter((u) => u.kind === 'level').length;
      const projects = plan.units.filter((u) => u.kind === 'project').length;
      return { text: loraIntroScript(firstName, record.title, levels, projects), refId: base };
    }

    if (q.kind === 'finish' && !q.unitId) {
      if (!this.summarize(plan, attempts).progress.finished) throw new ForbiddenException('The internship is not finished yet.');
      return { text: loraFinishScript({ firstName, title: record.title, isInternship: true }), refId: `${base}:all` };
    }

    if (!q.unitId) throw new BadRequestException('unitId is required.');
    const { unit, unitIndex } = this.requireUnit(plan, q.unitId);
    const states = this.unitStates(plan, attempts);
    if (states[unitIndex].status === 'locked') throw new ForbiddenException(this.lockedReason(unit));

    if (q.kind === 'unit') return { text: loraUnitScript(unit, firstName), refId: `${base}:${unit.id}` };

    if (q.kind === 'finish') {
      if (!states[unitIndex].completed) throw new ForbiddenException('That section is not finished yet.');
      return { text: loraFinishScript({ firstName, title: unit.title, isInternship: false }), refId: `${base}:${unit.id}` };
    }

    const stepIndex = Number.isInteger(q.stepIndex) ? (q.stepIndex as number) : NaN;
    const step = this.requireStep(unit, stepIndex);
    if (states[unitIndex].steps[stepIndex].status === 'locked') throw new ForbiddenException('That step is still locked.');
    const refId = `${base}:${unit.id}:${stepIndex}`;

    if (q.kind === 'step') return { text: loraStepScript(step, stepIndex + 1, unit.steps!.length), refId };

    if (q.kind === 'feedback') {
      const last = [...attempts].reverse().find((a) => a.unitId === unit.id && a.stepIndex === stepIndex);
      if (!last) throw new NotFoundException('There is no review to read yet.');
      const text = loraFeedbackScript({
        firstName,
        passed: last.passed,
        score: last.score,
        feedback: last.feedback,
        toFix: last.toFix ?? [],
        corrections: last.corrections ?? [],
        nextTip: last.nextTip,
        hasNext: stepIndex + 1 < unit.steps!.length,
      });
      return { text, refId: `${refId}:${new Date(last.attemptedAt).getTime()}` };
    }

    if (q.kind === 'mentor') {
      const msg = (record.workshopChat ?? []).find(
        (m) => m.role === 'assistant' && m.unitId === unit.id && m.stepIndex === stepIndex && new Date(m.createdAt).getTime() === q.createdAt,
      );
      if (!msg) throw new NotFoundException('That answer was not found.');
      return { text: msg.content, refId: `${refId}:${q.createdAt}` };
    }

    throw new BadRequestException('Unknown kind.');
  }

  /** Streams Lora's synthesized voice for one of the moments above. Cached per voice, so each script is only synthesized once. */
  async serveLoraAudio(
    req: Request,
    res: Response,
    userId: string,
    id: string,
    q: { kind: string; unitId?: string; stepIndex?: number; createdAt?: number },
    voice?: string,
  ) {
    const { text, refId } = await this.loraText(userId, id, q);
    await this.audio.serveAudio(req, res, 'internship-lora', refId, text, voice);
  }
}
