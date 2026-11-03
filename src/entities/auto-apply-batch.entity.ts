import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';
import { AutoApplyStatus } from './enums';

@Entity('auto_apply_batches')
export class AutoApplyBatch extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'integer' }) requestedCount: number;
  @Column({ type: 'integer', default: 0 }) completedCount: number;
  @Column({ type: 'integer', default: 0 }) succeededCount: number;
  @Column({ type: 'integer', default: 0 }) manualReviewCount: number;
  @Column({ type: 'integer', default: 0 }) failedCount: number;

  @Column({ type: 'jsonb' })
  filters: { query?: string; jobTypes?: string[]; location?: string; resumeId?: string; onlineOnly?: boolean; jobIds?: string[] };

  @Column({ type: 'text', default: 'QUEUED' })
  status: AutoApplyStatus;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
