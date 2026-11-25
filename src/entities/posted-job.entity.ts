import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { JobType } from './enums';
import { User } from './user.entity';

/**
 * A job posted by a member of the app (as opposed to `Job`, which is a listing scraped from an outside source).
 *
 * Every post has an `expiresAt`. Once that moment passes the post is gone: reads never return it, and
 * PostedJobsService deletes the row in its periodic sweep (see PostedJobsService.sweepExpired).
 */
@Entity('posted_jobs')
@Index(['ownerId', 'createdAt'])
export class PostedJob extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner?: User;

  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text', nullable: true }) company?: string | null;
  @Column({ type: 'text', nullable: true }) location?: string | null;
  @Column({ type: 'text', default: 'CUSTOM' }) jobType: JobType;
  @Column({ type: 'text', default: '' }) description: string;

  /** How to apply: a link, an email address, or both (at least one is always set). */
  @Column({ type: 'text', nullable: true }) applyUrl?: string | null;
  @Column({ type: 'text', nullable: true }) applyEmail?: string | null;

  @Column({ type: 'text', nullable: true }) salary?: string | null; // free text, e.g. "₦250,000 / month"
  @Column({ type: 'boolean', default: false }) isRemote: boolean;

  /** After this moment the post no longer exists (hidden at once, deleted by the next sweep). */
  @Index()
  @Column({ type: 'timestamptz' })
  expiresAt: Date;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
