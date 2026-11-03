import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';

/**
 * Which optional job-board providers are currently allowed to run.
 *
 * This is a GLOBAL operational switch, not a per-user preference: there is
 * exactly one row in this table (see JobSourceSettingsService, which always
 * reads/writes that singleton, creating it with defaults on first access).
 * The `singleton` column is `true` on the one row and UNIQUE, so the database
 * itself guarantees a second row can never be created, even by two requests
 * racing on first boot.
 *
 * Providers not represented here (Remotive, RemoteOK, Arbeitnow, Jobicy,
 * Contra) are always-on free sources and aren't gated by this table.
 */
@Entity('job_source_settings')
export class JobSourceSettings extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'boolean', default: true, unique: true })
  singleton: boolean;

  @Column({ type: 'boolean', default: false })
  adzunaEnabled: boolean;

  @Column({ type: 'boolean', default: false })
  weAreDevelopersEnabled: boolean;

  // No arc.dev JobSourceProvider is gated by this yet - the flag is wired end
  // to end (DB, API, frontend switch) ready for when one is.
  @Column({ type: 'boolean', default: false })
  arcDevEnabled: boolean;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
