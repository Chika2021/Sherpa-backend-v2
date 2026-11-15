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
import {
  InternshipCheckIn,
  InternshipSchedule,
  MAX_INTERNSHIP_MONTHS,
  MAX_STORED_CHECK_INS,
  MIN_INTERNSHIP_MONTHS,
  addMonthsKey,
  dateKey,
  dayOfStep,
  daysBetweenKeys,
  isValidTimeZone,
  planDays,
  stepsUnlockedBy,
  DAYS_PER_MONTH,
} from './internship-schedule';

const MAX_STORED_CHAT_MESSAGES = 150;

export type StepStatus = 'locked' | 'current' | 'passed';
export type UnitStatus = 'locked' | 'available' | 'in_progress' | 'completed';

/** Why a step is locked: the step before it is not passed yet, or its internship day has not been opened by a check-in. */
type StepLockReason = 'previous_step' | 'check_in';

export interface InternshipDurationInput {
  durationMode: 'self_paced' | 'timeframe';
  months?: number;
  timezone?: string;
}

interface StepProgress {
  status: StepStatus;
  lockedBy?: StepLockReason;
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
 *  - on a timeframe internship a step also needs its internship day opened by a check-in (see internship-schedule.ts);
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

  /**
   * `offset` = how many steps come before this unit in the whole internship; `limit` = how many steps
   * (counted from the start of the internship) the learner's check-ins have opened (Infinity = no calendar).
   */
  private stepProgress(unit: WorkshopUnit, attempts: WorkshopAttempt[], offset = 0, limit = Infinity): StepProgress[] {
    const mine = attempts.filter((a) => a.unitId === unit.id);
    const total = unit.steps?.length ?? unit.outline.length;
    const result: StepProgress[] = [];
    let previousPassed = true;

    for (let i = 0; i < total; i++) {
      const forStep = mine.filter((a) => a.stepIndex === i);
      const last = forStep[forStep.length - 1];
      const passed = forStep.some((a) => a.passed);
      const notCheckedIn = !passed && offset + i >= limit;
      const status: StepStatus = passed ? 'passed' : !notCheckedIn && previousPassed && unit.steps ? 'current' : 'locked';
      result.push({
        status,
        ...(status === 'locked' ? { lockedBy: (notCheckedIn ? 'check_in' : 'previous_step') as StepLockReason } : {}),
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

  private unitStates(plan: WorkshopPlan, attempts: WorkshopAttempt[], limit = Infinity) {
    let previousCompleted = true;
    let levelsAllCompleted = true;
    let offset = 0;

    return plan.units.map((unit) => {
      const steps = this.stepProgress(unit, attempts, offset, limit);
      offset += unit.outline.length;
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

  private summarize(plan: WorkshopPlan, attempts: WorkshopAttempt[], limit = Infinity) {
    const states = this.unitStates(plan, attempts, limit);
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
    const attempts = record.workshopAttempts ?? [];
    const { states, progress } = this.summarize(plan, attempts, this.stepLimit(record, plan));

    return {
      created: true as const,
      skillTutorialId: record.id,
      title: plan.title,
      tagline: plan.tagline,
      passScore: WORKSHOP_PASS_SCORE,
      progress,
      duration: this.durationView(record, plan, attempts),
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
  async create(userId: string, id: string, restart = false, duration?: InternshipDurationInput) {
    const record = await this.load(userId, id);
    if (record.workshop?.units?.length && !restart) return this.getOverview(userId, id);
    // Validate the duration choice BEFORE the (billed) plan generation, so a bad request costs nothing.
    if (duration) this.assertDurationInput(duration);

    const plan = await this.gemini.generateWorkshopPlan(userId, {
      title: record.title,
      level: record.level,
      overview: record.overview,
      modules: record.modules,
    });

    // A (re)built internship starts with a fresh schedule: the chosen duration, or nothing chosen yet.
    const schedule = duration ? this.buildSchedule(plan, duration) : null;
    await updateLockedRow(this.dataSource, SkillTutorial, { id: record.id, userId }, [], () => ({
      workshop: plan,
      workshopAttempts: [],
      workshopChat: [],
      internshipSchedule: schedule,
    }));
    return this.getOverview(userId, id);
  }

  // ---- internship duration & daily check-ins ----

  private flatSteps(plan: WorkshopPlan): Array<{ unitId: string; stepIndex: number; title: string }> {
    return plan.units.flatMap((u) => u.outline.map((o, i) => ({ unitId: u.id, stepIndex: i, title: u.steps?.[i]?.title || o.title })));
  }

  private scheduleTotals(plan: WorkshopPlan, months: number) {
    const totalSteps = plan.units.reduce((n, u) => n + u.outline.length, 0);
    return { totalSteps, totalDays: planDays(totalSteps, months) };
  }

  /** How many steps (from the start) the learner's check-ins have opened. Infinity when there is no calendar. */
  private stepLimit(record: SkillTutorial, plan: WorkshopPlan): number {
    const s = record.internshipSchedule;
    if (s?.mode !== 'timeframe' || !s.months) return Infinity;
    const { totalSteps, totalDays } = this.scheduleTotals(plan, s.months);
    return stepsUnlockedBy(s.daysUnlocked, totalSteps, totalDays);
  }

  /** Where the first step of a unit sits in the whole internship (0-based). */
  private unitOffset(plan: WorkshopPlan, unitIndex: number): number {
    return plan.units.slice(0, unitIndex).reduce((n, u) => n + u.outline.length, 0);
  }

  private assertDurationInput(input: InternshipDurationInput) {
    if (input.timezone !== undefined && !isValidTimeZone(input.timezone)) {
      throw new BadRequestException('That time zone is not recognised. Use an IANA name such as "Africa/Lagos".');
    }
    if (
      input.durationMode === 'timeframe' &&
      !(Number.isInteger(input.months) && (input.months as number) >= MIN_INTERNSHIP_MONTHS && (input.months as number) <= MAX_INTERNSHIP_MONTHS)
    ) {
      throw new BadRequestException(`Choose a whole number of months between ${MIN_INTERNSHIP_MONTHS} and ${MAX_INTERNSHIP_MONTHS}.`);
    }
  }

  private buildSchedule(plan: WorkshopPlan, input: InternshipDurationInput): InternshipSchedule {
    this.assertDurationInput(input);
    const timezone = input.timezone && isValidTimeZone(input.timezone) ? input.timezone : 'UTC';
    const base = { timezone, startedAt: new Date().toISOString(), daysUnlocked: 0, checkIns: [] as InternshipCheckIn[] };
    if (input.durationMode === 'self_paced') return { mode: 'self_paced', months: null, ...base };
    if (!plan.units.some((u) => u.outline.length)) throw new BadRequestException('The internship has no steps to schedule.');
    return { mode: 'timeframe', months: input.months as number, ...base };
  }

  private passedKeys(attempts: WorkshopAttempt[]): Set<string> {
    return new Set(attempts.filter((a) => a.passed).map((a) => `${a.unitId}:${a.stepIndex}`));
  }

  /** Steps that are open (checked in) but not passed yet. */
  private openTasks(plan: WorkshopPlan, attempts: WorkshopAttempt[], limit: number) {
    const passed = this.passedKeys(attempts);
    return this.flatSteps(plan)
      .map((s, g) => ({ ...s, global: g }))
      .filter((s) => s.global < limit && !passed.has(`${s.unitId}:${s.stepIndex}`));
  }

  /** The duration block of the overview: what was chosen and, for a timeframe, where the learner stands today. */
  private durationView(record: SkillTutorial, plan: WorkshopPlan, attempts: WorkshopAttempt[]) {
    const s = record.internshipSchedule;
    // Duration can be (re)chosen until the first step has been submitted.
    const canChange = attempts.length === 0;
    if (!s) return { chosen: false, mode: 'self_paced' as const, canChange };
    if (s.mode !== 'timeframe' || !s.months) return { chosen: true, mode: 'self_paced' as const, canChange };

    const { totalSteps, totalDays } = this.scheduleTotals(plan, s.months);
    const limit = stepsUnlockedBy(s.daysUnlocked, totalSteps, totalDays);
    const today = dateKey(new Date(), s.timezone);
    const startKey = dateKey(new Date(s.startedAt), s.timezone);
    const endKey = addMonthsKey(startKey, s.months);
    const elapsedDays = Math.max(0, daysBetweenKeys(startKey, today));
    const expectedDay = Math.min(totalDays, Math.floor((elapsedDays * totalDays) / (s.months * DAYS_PER_MONTH)) + 1);

    const flat = this.flatSteps(plan);
    const passed = this.passedKeys(attempts);
    const dayDone = new Array<boolean>(totalDays + 1).fill(true);
    flat.forEach((f, g) => {
      if (!passed.has(`${f.unitId}:${f.stepIndex}`)) dayDone[dayOfStep(g, totalSteps, totalDays)] = false;
    });
    const daysCompleted = dayDone.slice(1).filter(Boolean).length;

    const tasks = this.openTasks(plan, attempts, limit).map((t) => ({
      day: dayOfStep(t.global, totalSteps, totalDays),
      unitId: t.unitId,
      stepIndex: t.stepIndex,
      title: t.title,
    }));
    const nextDay = s.daysUnlocked < totalDays ? s.daysUnlocked + 1 : null;
    const nextDayTasks = nextDay
      ? flat
          .map((f, g) => ({ ...f, day: dayOfStep(g, totalSteps, totalDays) }))
          .filter((f) => f.day === nextDay)
          .map(({ unitId, stepIndex, title }) => ({ unitId, stepIndex, title }))
      : [];

    const checkedInToday = s.checkIns.some((c) => c.date === today);
    const allOpen = s.daysUnlocked >= totalDays;
    const mustFinishFirst = checkedInToday && tasks.length > 0;

    return {
      chosen: true,
      mode: 'timeframe' as const,
      canChange,
      months: s.months,
      timezone: s.timezone,
      startDate: startKey,
      endDate: endKey,
      daysLeft: Math.max(0, daysBetweenKeys(today, endKey)),
      totalDays,
      daysUnlocked: s.daysUnlocked,
      daysCompleted,
      expectedDay,
      // > 0 means the learner has opened fewer days than the plan expects by today.
      daysBehind: Math.max(0, expectedDay - s.daysUnlocked),
      checkedInToday,
      checkInDays: new Set(s.checkIns.map((c) => c.date)).size,
      canCheckIn: !allOpen && !mustFinishFirst,
      checkInBlockedReason: allOpen ? 'all_days_open' : mustFinishFirst ? 'finish_open_tasks' : null,
      maxDaysToOpen: totalDays - s.daysUnlocked,
      tasks: tasks.slice(0, 50),
      nextDay,
      nextDayTasks,
    };
  }

  /**
   * Choose how the internship runs: keep it open-ended ("self_paced") or fix a number of months ("timeframe").
   * Allowed until the learner submits their first step - after that the plan is locked in.
   */
  async setDuration(userId: string, id: string, input: InternshipDurationInput) {
    const record = await this.load(userId, id);
    const plan = this.requirePlan(record);
    const schedule = this.buildSchedule(plan, input);

    await updateLockedRow<{ workshopAttempts: any[] | null }>(
      this.dataSource,
      SkillTutorial,
      { id: record.id, userId },
      ['workshopAttempts'],
      (row) => {
        if ((row.workshopAttempts ?? []).length) {
          throw new ForbiddenException('The internship duration can only be changed before you submit your first step.');
        }
        return { internshipSchedule: schedule };
      },
    );
    return { duration: this.durationView({ ...record, internshipSchedule: schedule } as SkillTutorial, plan, []) };
  }

  /** The current duration block (same as `duration` in the overview). */
  async getDuration(userId: string, id: string) {
    const record = await this.load(userId, id);
    const plan = this.requirePlan(record);
    return { duration: this.durationView(record, plan, record.workshopAttempts ?? []) };
  }

  /**
   * Daily check-in: opens the next internship day (the day's task). `days` > 1 opens several days at once
   * ("working ahead"). A second check-in on the same calendar day is only allowed once everything already open is passed.
   */
  async checkIn(userId: string, id: string, days = 1, timezone?: string) {
    const record = await this.load(userId, id);
    const plan = this.requirePlan(record);
    const current = record.internshipSchedule;
    if (current?.mode !== 'timeframe' || !current.months) {
      throw new BadRequestException('Daily check-ins only apply when the internship has a time frame. Set one first.');
    }
    if (timezone !== undefined && !isValidTimeZone(timezone)) {
      throw new BadRequestException('That time zone is not recognised. Use an IANA name such as "Africa/Lagos".');
    }

    const attempts = record.workshopAttempts ?? [];
    const { totalSteps, totalDays } = this.scheduleTotals(plan, current.months);
    const now = new Date();
    let opened = 0;

    await updateLockedRow<{ internshipSchedule: InternshipSchedule | null }>(
      this.dataSource,
      SkillTutorial,
      { id: record.id, userId },
      ['internshipSchedule'],
      (row) => {
        const cur = row.internshipSchedule;
        if (cur?.mode !== 'timeframe' || !cur.months) throw new BadRequestException('Daily check-ins only apply when the internship has a time frame.');
        const tz = timezone ?? cur.timezone;
        const today = dateKey(now, tz);

        if (cur.daysUnlocked >= totalDays) throw new BadRequestException('Every day of your internship is already open.');
        if (cur.checkIns.some((c) => c.date === today)) {
          const limit = stepsUnlockedBy(cur.daysUnlocked, totalSteps, totalDays);
          if (this.openTasks(plan, attempts, limit).length) {
            throw new BadRequestException("You've already checked in today. Finish the tasks that are open and you can open more days.");
          }
        }

        opened = Math.min(Math.max(1, Math.floor(days)), totalDays - cur.daysUnlocked);
        const after = cur.daysUnlocked + opened;
        const entry: InternshipCheckIn = { at: now.toISOString(), date: today, daysOpened: opened, daysUnlockedAfter: after };
        return {
          internshipSchedule: { ...cur, timezone: tz, daysUnlocked: after, checkIns: appendKeepingLast(cur.checkIns, [entry], MAX_STORED_CHECK_INS) },
        };
      },
    );

    const fresh = await this.load(userId, id);
    return { opened, duration: this.durationView(fresh, plan, fresh.workshopAttempts ?? []) };
  }

  private lockedStepMessage(progress: StepProgress): string {
    return progress.lockedBy === 'check_in'
      ? 'This task belongs to a day you have not opened yet. Check in to unlock it.'
      : 'Pass the previous step first - each step builds on the one before it.';
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
    const state = this.unitStates(plan, attempts, this.stepLimit(record, plan)).find((s) => s.unit.id === unitId)!;
    const timeframe = record.internshipSchedule?.mode === 'timeframe' ? record.internshipSchedule : null;
    const totals = timeframe?.months ? this.scheduleTotals(plan, timeframe.months) : null;
    const offset = this.unitOffset(plan, plan.units.findIndex((u) => u.id === unitId));
    // The internship day a step belongs to (timeframe internships only).
    const dayOf = (index: number) => (totals ? { dayNumber: dayOfStep(offset + index, totals.totalSteps, totals.totalDays) } : {});

    const card = this.unitCard(state);
    if (state.status === 'locked') {
      return { ...card, locked: true, lockedReason: this.lockedReason(unit), steps: [] };
    }

    const steps = (unit.steps ?? []).map((step, index) => {
      const p = state.steps[index];
      const unlocked = p.status !== 'locked';
      // A locked step shows only its title and phase, so the learner works through the guide in order rather than skipping ahead.
      if (!unlocked) {
        return { stepIndex: index, title: step.title, phase: step.phase, status: p.status, lockedReason: this.lockedStepMessage(p), ...dayOf(index) };
      }
      return {
        stepIndex: index,
        status: p.status,
        ...dayOf(index),
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
    const limit = this.stepLimit(record, plan);
    const states = this.unitStates(plan, attempts, limit);

    if (states[unitIndex].status === 'locked') throw new ForbiddenException(this.lockedReason(unit));
    // On a timeframe internship a section opens once the check-in for its first task has been done.
    if (this.unitOffset(plan, unitIndex) >= limit) throw new ForbiddenException('This section starts on a day you have not opened yet. Check in to unlock it.');

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
    const limit = this.stepLimit(record, plan);
    const states = this.unitStates(plan, attempts, limit);
    const state = states[unitIndex];

    if (state.status === 'locked') throw new ForbiddenException(this.lockedReason(unit));
    const step = this.requireStep(unit, stepIndex);
    const progress = state.steps[stepIndex];
    if (progress.status === 'locked') throw new ForbiddenException(this.lockedStepMessage(progress));

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

    const after = this.summarize(plan, [...attempts, attempt], limit);
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
    const state = this.unitStates(plan, attempts, this.stepLimit(record, plan))[unitIndex];

    if (state.status === 'locked') throw new ForbiddenException(this.lockedReason(unit));
    const step = this.requireStep(unit, stepIndex);
    const progress = state.steps[stepIndex];
    if (progress.status === 'locked') throw new ForbiddenException(progress.lockedBy === 'check_in' ? this.lockedStepMessage(progress) : 'That step is still locked.');

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
    const summary = plan ? this.summarize(plan, attempts, this.stepLimit(record, plan)) : null;
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
    const limit = this.stepLimit(record, plan);
    const firstName = await this.firstNameOf(userId);
    const base = `${record.id}:${q.kind}`;

    if (q.kind === 'intro') {
      const levels = plan.units.filter((u) => u.kind === 'level').length;
      const projects = plan.units.filter((u) => u.kind === 'project').length;
      return { text: loraIntroScript(firstName, record.title, levels, projects), refId: base };
    }

    if (q.kind === 'finish' && !q.unitId) {
      if (!this.summarize(plan, attempts, limit).progress.finished) throw new ForbiddenException('The internship is not finished yet.');
      return { text: loraFinishScript({ firstName, title: record.title, isInternship: true }), refId: `${base}:all` };
    }

    if (!q.unitId) throw new BadRequestException('unitId is required.');
    const { unit, unitIndex } = this.requireUnit(plan, q.unitId);
    const states = this.unitStates(plan, attempts, limit);
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
