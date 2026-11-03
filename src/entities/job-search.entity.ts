import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';
import { JobType } from './enums';

@Entity('job_searches')
export class JobSearch extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'text', nullable: true }) query?: string;
  @Column({ type: 'text', array: true, default: () => "'{}'" }) jobTypes: JobType[];
  @Column({ type: 'text', nullable: true }) location?: string;

  // Not a relation - just records which resume this search used (no FK on purpose).
  @Column({ type: 'uuid', nullable: true }) resumeId?: string;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
