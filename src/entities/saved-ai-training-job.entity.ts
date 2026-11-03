import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from './user.entity';

/**
 * An AI-training job a user chose to keep.
 *
 * AI-training listings are fetched live from public feeds and are never stored
 * in the `jobs` table, so unlike SavedJob (which points at a Job row) this
 * stores a snapshot of the listing itself. That is what lets a saved job
 * still be there next time the app opens, even after the upstream posting has
 * dropped out of the feed.
 *
 * (Not serialized directly - SavedAiTrainingJobsService maps rows to the
 * `SavedAiTrainingJobView` shape, exactly as before.)
 */
@Entity('saved_ai_training_jobs')
@Index(['userId', 'jobId'], { unique: true }) // one saved copy of a listing per user
@Index(['userId', 'savedAt'])
export class SavedAiTrainingJob {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  /** The listing's own id, `${source}:${externalId}` - matches AiTrainingJob.id on the search results. */
  @Column({ type: 'text' }) jobId: string;

  @Column({ type: 'text' }) source: string;
  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text', nullable: true }) company?: string;
  @Column({ type: 'text' }) category: string;
  @Column({ type: 'text', nullable: true }) location?: string;
  @Column({ type: 'boolean', default: false }) remote: boolean;
  @Column({ type: 'text', default: '' }) employmentType: string;
  @Column({ type: 'text', default: '' }) summary: string;
  @Column({ type: 'text' }) applyUrl: string;
  @Column({ type: 'text', nullable: true }) postedAt?: string;
  @Column({ type: 'jsonb', nullable: true })
  pay?: { min?: number; max?: number; currency?: string; text?: string; unit: string };

  @Column({ type: 'timestamptz', default: () => 'now()' })
  savedAt: Date;
}
