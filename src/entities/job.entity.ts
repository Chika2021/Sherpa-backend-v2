import { createHash } from 'crypto';
import { BeforeInsert, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { JobType } from './enums';

/**
 * Stable identity of a listing: the old Mongoose schema declared a UNIQUE
 * compound index on { source, externalId, applyUrl }. Postgres btree indexes
 * can't hold very long values (~2.7KB per entry) and apply URLs are
 * unbounded, so the uniqueness is enforced on a SHA-256 of the three values
 * instead. Same rule, no index-size failure mode.
 */
export function jobDedupeKey(source: string, externalId: string | null | undefined, applyUrl: string): string {
  return createHash('sha256').update(`${source}\u0000${externalId ?? ''}\u0000${applyUrl}`).digest('hex');
}

@Entity('jobs')
@Index(['company', 'postedAt'])
export class Job extends SerializableEntity {
  static readonly keepNull = ['raw'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'text' }) source: string; // e.g. "gemini", "adzuna", "manual"
  @Column({ type: 'text', nullable: true }) externalId?: string; // id from the upstream source, if any
  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text', nullable: true }) company?: string;
  @Column({ type: 'text', nullable: true }) companyLogoUrl?: string;
  @Column({ type: 'text', nullable: true }) location?: string;
  @Column({ type: 'text', default: 'CUSTOM' }) jobType: JobType;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'text' }) applyUrl: string;
  @Column({ type: 'text', nullable: true }) salary?: string; // free-text salary as given by the source, e.g. "$120k - $150k"
  @Column({ type: 'double precision', nullable: true }) salaryMin?: number;
  @Column({ type: 'double precision', nullable: true }) salaryMax?: number;
  @Column({ type: 'text', nullable: true }) salaryCurrency?: string; // ISO 4217 code, e.g. "USD" - best-effort
  @Column({ type: 'boolean', nullable: true }) isRemote?: boolean;

  // Normalized work-arrangement tags (distinct from `jobType`), e.g.
  // ['4-day week'], ['9-day fortnight'], ['full-time'].
  @Column({ type: 'text', array: true, nullable: true }) workSchedule?: string[];

  // When the source itself published the listing. Distinct from `createdAt`,
  // which records when THIS APP first scraped/ingested it.
  @Column({ type: 'timestamptz', nullable: true }) postedAt?: Date;

  @Column({ type: 'jsonb', nullable: true, default: null }) raw?: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;

  // Internal uniqueness key - see jobDedupeKey. Never selected, never serialized.
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, select: false })
  dedupeKey?: string;

  @BeforeInsert()
  private ensureDedupeKey() {
    if (!this.dedupeKey) this.dedupeKey = jobDedupeKey(this.source, this.externalId, this.applyUrl);
  }
}

