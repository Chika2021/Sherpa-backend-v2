import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { SkillTutorialModule, SkillCourseGuide, CbtQuestion, LabExercise } from '../ai/gemini.service';
import type { AskAiMessage } from '../common/ask-ai.types';
import type { SkillVideo } from '../ai/skill-video.types';
import type { WorkshopPlan } from '../ai/workshop.prompts';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

export interface SkillCbtAnswer {
  questionIndex: number;
  selectedOptionIndex: number;
  correct: boolean;
}

/** One submitted checkpoint in the AI Workshop. Append-only: progress is derived from these. */
export interface WorkshopAttempt {
  unitId: string; // "L1".."L4" (levels) / "P1".."P3" (projects)
  stepIndex: number;
  submission: string;
  score: number; // 0-100
  passed: boolean;
  feedback: string;
  wentWell: string[];
  toFix: string[];
  // Plain-language explanation of each mistake: what, why, how to fix (+ before/after lines).
  corrections?: Array<{ problem: string; why: string; fix: string; before?: string; after?: string }>;
  nextTip: string;
  /** Stored inside a JSON column, so after a round-trip through the database this is an ISO string. */
  attemptedAt: Date | string;
}

/** One message in a workshop step's chat with the AI supervisor. */
export interface WorkshopChatMessage {
  role: 'user' | 'assistant';
  content: string;
  unitId: string;
  stepIndex: number;
  /** Stored inside a JSON column, so after a round-trip through the database this is an ISO string. */
  createdAt: Date | string;
}

export interface SkillLabAttempt {
  exerciseIndex: number;
  submission: string;
  correct: boolean;
  score: number; // 0-100
  feedback: string;
  /** Stored inside a JSON column, so after a round-trip through the database this is an ISO string. */
  attemptedAt: Date | string;
}

/**
 * A "Build Skill" course generated from a user-typed skill/course name:
 * an AI-written tutorial (read aloud module-by-module by the client's voice
 * tutor), an optional CBT practice quiz generated from it, and an optional
 * set of hands-on lab exercises the learner can attempt in real time.
 *
 * The quiz's options/correctOptionIndex/explanation and the lab's
 * modelSolution are real data on this row but withheld by SkillsService from
 * unanswered questions in the API response.
 */
@Entity('skill_tutorials')
export class SkillTutorial extends SerializableEntity {
  static readonly keepNull = ['internshipDocument'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  // The skill/course name the user typed in, e.g. "React Hooks".
  @Column({ type: 'text' })
  title: string;

  @Column({ type: 'text' })
  level: string;

  @Column({ type: 'text' })
  overview: string;

  @Column({ type: 'double precision' })
  estimatedMinutes: number;

  @Column({ type: 'jsonb' })
  modules: SkillTutorialModule[];

  // Course-level material around the modules (audience, prerequisites,
  // learning outcomes, study guide, capstone, glossary, ...). Optional -
  // tutorials generated before it existed don't have it.
  @Column({ type: 'jsonb', nullable: true })
  courseGuide?: SkillCourseGuide | null;

  // Cached path to the generated downloadable PDF, so repeat downloads
  // don't re-render the file from scratch.
  @Column({ type: 'text', nullable: true })
  tutorialFilePath?: string | null;

  // ---- CBT (multiple-choice practice quiz) ----
  // Generated lazily via POST /skills/:id/cbt, not at creation time.
  @Column({ type: 'jsonb', nullable: true })
  cbtQuestions?: CbtQuestion[];

  // The current attempt's per-question answers, in the order answered.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  cbtAnswers: SkillCbtAnswer[];

  @Column({ type: 'boolean', default: false })
  cbtCompleted: boolean;

  // ---- Lab (real-time hands-on practice) ----
  // Generated lazily via POST /skills/:id/lab, not at creation time.
  @Column({ type: 'jsonb', nullable: true })
  labExercises?: LabExercise[];

  // Every attempt across every exercise, most recent last.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  labAttempts: SkillLabAttempt[];

  // ---- Tutorial videos ----
  // Real YouTube tutorials the AI found for this course. `select: false`
  // keeps them out of the normal course responses - they're loaded by the
  // /videos endpoints only.
  @Column({ type: 'jsonb', default: () => "'[]'", select: false })
  videos: SkillVideo[];

  // ---- AI Workshop (internship-style practical training) ----
  // All three are `select: false` (the plan carries every step's code, so it
  // is large) and are only loaded by the /workshop endpoints.
  @Column({ type: 'jsonb', nullable: true, select: false })
  workshop?: WorkshopPlan;

  // Every checkpoint ever submitted, oldest first.
  @Column({ type: 'jsonb', default: () => "'[]'", select: false })
  workshopAttempts: WorkshopAttempt[];

  // The learner's conversation with the AI supervisor, across all steps.
  @Column({ type: 'jsonb', default: () => "'[]'", select: false })
  workshopChat: WorkshopChatMessage[];

  // The internship document issued after the learner finished the internship and paid for it.
  // Set once (first download after payment); the number never changes afterwards.
  @Column({ type: 'jsonb', nullable: true, default: null })
  internshipDocument?: { number: string; issuedAt: Date | string; reference: string } | null;

  // ---- Ask AI ----
  // `select: false` keeps it out of the normal course responses.
  @Column({ type: 'jsonb', default: () => "'[]'", select: false })
  askAiMessages: AskAiMessage[];

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
