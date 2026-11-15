import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';

/**
 * Case/accent/spacing-insensitive identity of a country name, so "Nigeria", " nigeria " and "NIGERIA" are the
 * same board and "Côte d'Ivoire" == "Cote d'Ivoire". Stored in `countryKey` (UNIQUE) so the database itself
 * refuses a second board for the same country, even when two admins save at the same moment.
 */
export function localBoardCountryKey(country: string): string {
  return country
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A "local job board": the list of job-board links an admin keeps for ONE country. Admins paste all the links
 * for a country and the board is updated from that paste (see LocalJobBoardsService).
 *
 * One row per country. `links` holds normalised, de-duplicated http(s) URLs; `linkCount` is kept in step with it
 * so list views don't have to load every link.
 */
@Entity('local_job_boards')
export class LocalJobBoard extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Display name exactly as the admin typed it (trimmed), e.g. "Nigeria". */
  @Column({ type: 'text' })
  country: string;

  /** Internal uniqueness key - see localBoardCountryKey. Never selected, never serialized. */
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 120, select: false })
  countryKey?: string;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  links: string[];

  @Column({ type: 'int', default: 0 })
  linkCount: number;

  @Column({ type: 'text', nullable: true }) createdById?: string;
  @Column({ type: 'text', nullable: true }) updatedById?: string;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
