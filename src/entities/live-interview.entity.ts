import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { LiveInterviewAssessment, LiveInterviewTurnKind } from '../ai/live-interview.prompts';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';
import { InterviewPrep } from './interview-prep.entity';

/**
 * - in_progress  the conversation is still going
 * - completed    Lora wrapped up normally (every planned question covered)
 * - ended_early  the candidate stopped it part-way, after answering at least one question
 * - abandoned    stopped (or replaced by a new attempt) before any answer was given - never scored
 */
export type LiveInterviewStatus = 'in_progress' | 'completed' | 'ended_early' | 'abandoned';

/** One line of the conversation. */
export interface LiveInterviewTurn {
  role: 'interviewer' | 'candidate';
  /** Interviewer: exactly what Lora said (and what the audio endpoint speaks). Candidate: what they said or typed. */
  content: string;
  /** Interviewer turns only. */
  kind?: LiveInterviewTurnKind;
  /** Candidate turns only. */
  inputMode?: 'voice' | 'text';
  /** Candidate turns only. Private until the interview is over (see LiveInterviewService.toState). */
  assessment?: LiveInterviewAssessment;
  /** Stored inside a JSON column, so after a round-trip through the database this is an ISO string. */
  createdAt: Date | string;
}

export interface LiveInterviewResult {
  overallScore: number; // 0-100, plain average of every answer's private score
  summary: string;
  strengths: string[];
  improvements: string[];
  answeredCount: number;
  endedEarly: boolean;
}

/**
 * One "Live Interview with Lora" attempt for an interview-prep session.
 *
 * Kept in its own table (not embedded in InterviewPrep) because a live
 * conversation is long, is appended to turn by turn, and a person can keep a
 * history of several attempts for the same job.
 */
@Entity('live_interviews')
@Index(['interviewPrepId', 'userId', 'createdAt'])
export class LiveInterview extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Index()
  @Column({ type: 'uuid' })
  interviewPrepId: string;

  @ManyToOne(() => InterviewPrep, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'interviewPrepId' })
  interviewPrep?: InterviewPrep;

  @Index()
  @Column({ type: 'text', default: 'in_progress' })
  status: LiveInterviewStatus;

  // Which of GET /interview-prep/voices Lora speaks in for this attempt.
  @Column({ type: 'text' })
  voice: string;

  // The shape of the interview, fixed at the start.
  @Column({ type: 'integer' })
  totalQuestions: number;

  @Column({ type: 'integer' })
  maxFollowUps: number;

  // Main (non-follow-up) questions asked so far, including the opening one.
  @Column({ type: 'integer', default: 0 })
  questionsAsked: number;

  // Follow-ups already asked on the current main question; reset when Lora moves on.
  @Column({ type: 'integer', default: 0 })
  followUpsOnCurrent: number;

  // The whole conversation, oldest first. Appended atomically (see LiveInterviewService.appendTurns).
  @Column({ type: 'jsonb', default: () => "'[]'" })
  turns: LiveInterviewTurn[];

  // Set once the interview is finished and the report has been generated.
  @Column({ type: 'jsonb', nullable: true, default: null })
  result: LiveInterviewResult | null;

  // A reply is being generated right now. Guards against a double-tap or two
  // tabs submitting at once. A lock older than a couple of minutes is treated as stale.
  @Column({ type: 'timestamptz', nullable: true, default: null })
  processingSince: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
