import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { Consultation } from './consultation.entity';

/**
 * One meeting inside a consultation. A single class has one session; a multi-day seminar or a course has many
 * (day 1, day 2, day 3...). Students pay ONCE for the whole consultation and can join every session.
 *
 * `Consultation.startsAt` / `endsAt` always equal the first session's start and the last session's end, so
 * "live", sorting and the end-of-consultation payout keep working off those two columns.
 */
@Entity('consultation_sessions')
@Index(['consultationId', 'startsAt'])
export class ConsultationSession extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  consultationId: string;

  @ManyToOne(() => Consultation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'consultationId' })
  consultation?: Consultation;

  /** 0-based order (day 1 = 0). */
  @Column({ type: 'int', default: 0 }) position: number;

  /** Optional name of this session, e.g. "Day 2 - Mock interviews". */
  @Column({ type: 'text', nullable: true }) title?: string | null;

  @Column({ type: 'timestamptz' }) startsAt: Date;
  @Column({ type: 'timestamptz' }) endsAt: Date;

  /** Optional Google Meet link just for this session. Falls back to the consultation's own link. Same privacy rules as there. */
  @Column({ type: 'text', nullable: true }) meetLink?: string | null;
}
