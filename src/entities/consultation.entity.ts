import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

export const CONSULTATION_CATEGORIES = ['CAREER', 'CV_REVIEW', 'INTERVIEW_PREP', 'TECH', 'BUSINESS', 'DESIGN', 'EDUCATION', 'OTHER'] as const;
export type ConsultationCategory = (typeof CONSULTATION_CATEGORIES)[number];

/**
 * A virtual consultation (a class, a coaching session, a review...) that a member sells to other members.
 *
 * The seller sets when it starts and ends and a price in USD. Buyers pay through the payment gateway to enrol, and only then (and the
 * seller) can see `meetLink`, the Google Meet address. When `endsAt` passes the row is deleted by
 * ConsultationsService.sweepEnded, after the seller has been paid for everyone who enrolled.
 */
@Entity('consultations')
@Index(['ownerId', 'createdAt'])
export class Consultation extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  ownerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ownerId' })
  owner?: User;

  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text', default: '' }) description: string;
  @Column({ type: 'text', default: 'OTHER' }) category: ConsultationCategory;

  /** What enrolling costs, in US dollars. Students pay it through the payment gateway (Paystack), never with tokens. */
  @Column({ type: 'double precision' }) priceUsd: number;

  /** Most students that can enrol. Null = no limit. */
  @Column({ type: 'int', nullable: true }) capacity?: number | null;

  @Column({ type: 'timestamptz' }) startsAt: Date;

  /** After this moment the consultation no longer exists (hidden at once, deleted by the next sweep). */
  @Index()
  @Column({ type: 'timestamptz' })
  endsAt: Date;

  /**
   * Unguessable code behind the owner's shareable link (FRONTEND_URL/consultations/join/<shareCode>). Null = no link has been
   * generated (or it was revoked, which kills the old link at once). Unique, so a code always points at one consultation.
   */
  @Index({ unique: true })
  @Column({ type: 'text', nullable: true, default: null })
  shareCode?: string | null;

  /** The Google Meet link, added by the owner. NEVER sent to anyone who has not enrolled (see ConsultationsService.present). */
  @Column({ type: 'text', nullable: true }) meetLink?: string | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
