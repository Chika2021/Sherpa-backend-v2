import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { JobSearch } from './job-search.entity';
import { Job } from './job.entity';

@Entity('job_search_results')
@Index(['jobSearchId', 'jobId'], { unique: true })
export class JobSearchResult extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  jobSearchId: string;

  @ManyToOne(() => JobSearch, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobSearchId' })
  jobSearch?: JobSearch;

  @Index()
  @Column({ type: 'uuid' })
  jobId: string;

  // Loaded with `relations: { job: true }` - the equivalent of the old `.populate('job')`.
  @ManyToOne(() => Job, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId' })
  job?: Job;

  @Column({ type: 'double precision', nullable: true }) matchScore?: number;
  @Column({ type: 'text', nullable: true }) matchReason?: string;
  @Column({ type: 'integer', nullable: true }) rank?: number;
}
