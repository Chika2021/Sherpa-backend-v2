import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { InterviewQuestion, CbtQuestion } from '../ai/gemini.service';
import type { AskAiMessage } from '../common/ask-ai.types';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

export interface CbtAnswer {
  questionIndex: number;
  selectedOptionIndex: number;
  correct: boolean;
}

export interface VoiceAnswer {
  questionIndex: number;
  transcript: string;
  score: number; // 0-100
  feedback: string;
  strengths: string[];
  improvements: string[];
}

export interface VoiceInterviewResult {
  overallScore: number; // 0-100, average of per-answer scores
  summary: string;
  strengths: string[];
  improvements: string[];
}

/**
 * An interview prep session for a specific job: AI-generated interview
 * questions with model answers, and an optional CBT (multiple-choice
 * practice quiz) generated on demand from those questions.
 *
 * The CBT's options/correctOptionIndex/explanation are real data on this
 * row, but InterviewPrepService withholds them from the API response for
 * questions the user hasn't answered yet (see getCbt).
 */
@Entity('interview_preps')
export class InterviewPrep extends SerializableEntity {
  static readonly keepNull = ['voiceInterviewResult'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'text' })
  jobTitle: string;

  @Column({ type: 'text' })
  jobDescription: string;

  @Column({ type: 'text', nullable: true })
  jobRequirements?: string;

  @Column({ type: 'jsonb' })
  questions: InterviewQuestion[];

  // Generated lazily via POST /interview-prep/:id/cbt, not at creation time.
  @Column({ type: 'jsonb', nullable: true })
  cbtQuestions?: CbtQuestion[];

  // The current attempt's per-question answers, in the order answered.
  // Reset whenever /cbt/restart is called.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  cbtAnswers: CbtAnswer[];

  @Column({ type: 'boolean', default: false })
  cbtCompleted: boolean;

  // ---- Voice interview ----
  // Per-question answers for the current attempt, in the order answered.
  @Column({ type: 'jsonb', default: () => "'[]'" })
  voiceAnswers: VoiceAnswer[];

  @Column({ type: 'boolean', default: false })
  voiceInterviewCompleted: boolean;

  // Set once every question has been answered. Cleared on restart.
  @Column({ type: 'jsonb', nullable: true, default: null })
  voiceInterviewResult: VoiceInterviewResult | null;

  // ---- Ask AI ----
  // `select: false` keeps the conversation out of normal session responses -
  // it is only loaded explicitly by the /ask endpoints.
  @Column({ type: 'jsonb', default: () => "'[]'", select: false })
  askAiMessages: AskAiMessage[];

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
