import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';

/**
 * A reading of how much space the app uses, taken about every 6 hours (and whenever the super admin opens
 * the App storage page after that long). It is what lets the dashboard show growth over time.
 * Tiny: one row per reading, pruned after about a year.
 */
@Entity('storage_snapshots')
export class StorageSnapshot extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  takenAt: Date;

  @Column({ type: 'bigint' })
  totalBytes: string;

  @Column({ type: 'bigint' })
  databaseBytes: string;

  @Column({ type: 'bigint' })
  filesBytes: string;

  /** Database bytes per feature key, e.g. { resumes: 120000, "user-activity": 5400000 }. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  features: Record<string, number>;
}
