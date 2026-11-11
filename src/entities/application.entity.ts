import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';
import { Job } from './job.entity';
import { Resume } from './resume.entity';
import { AutoApplyBatch } from './auto-apply-batch.entity';
import { ApplicationStatus } from './enums';

@Entity('applications')
@Index(['userId', 'jobId'], { unique: true })
export class Application extends SerializableEntity {
  // Columns the API has always returned as an explicit `null` when empty.
  static readonly keepNull = ['appliedUrl', 'feedback', 'submittedAt', 'guidedAnswers'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @Index()
  @Column({ type: 'uuid' })
  jobId: string;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  resumeId?: string;

  @Column({ type: 'text', default: 'PENDING' })
  status: ApplicationStatus;

  // The application-form link the user pasted for the assisted-apply flow. Kept
  // here rather than on the Job because Job rows are shared between users (and
  // may only have a listing-page URL from the AI search), while this is the
  // specific form this user actually filled in.
  @Column({ type: 'text', nullable: true, default: null }) appliedUrl?: string | null;

  // Guided apply: the answers generated for the pasted form / link, kept so the
  // user can come back and copy them later. Shape: GuidedAnswer[] (see guided-apply.service.ts).
  @Column({ type: 'jsonb', nullable: true, default: null }) guidedAnswers?: Array<Record<string, any>> | null;

  @Column({ type: 'text', nullable: true, default: null }) feedback?: string | null;
  @Column({ type: 'timestamptz', nullable: true, default: null }) submittedAt?: Date | null;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  autoApplyBatchId?: string;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;

  // ---- Relations: only present when explicitly loaded (`relations: { job: true }`),
  // which is the TypeORM equivalent of the old `.populate('job')`. The raw
  // `jobId` / `userId` / `resumeId` columns above are ALWAYS there, so
  // `application.jobId` and `application.job` both work, as before.
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @ManyToOne(() => Job, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId' })
  job?: Job;

  @ManyToOne(() => Resume, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'resumeId' })
  resume?: Resume;

  @ManyToOne(() => AutoApplyBatch, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'autoApplyBatchId' })
  autoApplyBatch?: AutoApplyBatch;
}
