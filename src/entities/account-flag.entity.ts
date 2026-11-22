import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

export const FLAG_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

/**
 *  OPEN        waiting for an admin
 *  WARNED      the user was warned
 *  SUSPENDED   the account was suspended from this flag
 *  DISMISSED   reviewed: nothing wrong
 *  RESOLVED    handled another way (for example the suspension was lifted)
 */
export const FLAG_STATUSES = ['OPEN', 'WARNED', 'SUSPENDED', 'DISMISSED', 'RESOLVED'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

/** What the admins are shown about the activity behind a flag. */
export interface FlagEvidence {
  /** One sentence: what happened. */
  summary: string;
  /** What the user did, oldest first. */
  activity: Array<{ at: string; action: string }>;
  /** Other accounts involved (same device, same IP, the referrer...). */
  related?: Array<{ userId: string | null; email: string; note?: string }>;
  /** Numbers behind the rule (counts, thresholds, masked IP). */
  data?: Record<string, string | number | boolean | null>;
}

/** An account the monitoring rules found suspicious, with the reason and the activity, waiting for review. */
@Entity('account_flags')
@Index(['status', 'createdAt'])
@Index(['userId', 'status'])
export class AccountFlag extends SerializableEntity {
  static readonly keepNull = ['userId', 'reviewedById', 'reviewedByName', 'reviewedAt', 'reviewNote'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  // SET NULL (not CASCADE): the flag is an audit record and outlives a deleted account. `userEmail` keeps who it was.
  @Index()
  @Column({ type: 'uuid', nullable: true, default: null })
  userId?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true, createForeignKeyConstraints: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'text' }) userEmail: string;

  /** Machine name of the rule that fired, e.g. SAME_DEVICE_ACCOUNTS. */
  @Index()
  @Column({ type: 'text' }) rule: string;

  @Column({ type: 'text', default: 'MEDIUM' }) severity: FlagSeverity;
  /** 1 LOW, 2 MEDIUM, 3 HIGH - so the review queue can be sorted worst-first in SQL. */
  @Column({ type: 'int', default: 2 }) severityRank: number;
  @Column({ type: 'text', default: 'OPEN' }) status: FlagStatus;

  /** Short headline, e.g. "3 accounts created from the same device". */
  @Column({ type: 'text' }) title: string;
  /** Plain-English explanation of WHY the account was flagged. */
  @Column({ type: 'text' }) reason: string;
  /** The activity the user was involved in. */
  @Column({ type: 'jsonb' }) evidence: FlagEvidence;

  /** How many times the rule fired while this flag was open. */
  @Column({ type: 'int', default: 1 }) occurrences: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) lastSeenAt: Date;

  @Column({ type: 'uuid', nullable: true, default: null }) reviewedById?: string | null;
  @Column({ type: 'text', nullable: true, default: null }) reviewedByName?: string | null;
  @Column({ type: 'timestamptz', nullable: true, default: null }) reviewedAt?: Date | null;
  @Column({ type: 'text', nullable: true, default: null }) reviewNote?: string | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
