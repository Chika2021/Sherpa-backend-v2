import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { Consultation } from './consultation.entity';
import { User } from './user.entity';

/** One student who paid (through the payment gateway) to enrol in a consultation. A student can enrol once per consultation. */
@Entity('consultation_enrollments')
@Unique(['consultationId', 'buyerId'])
export class ConsultationEnrollment extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  consultationId: string;

  @ManyToOne(() => Consultation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'consultationId' })
  consultation?: Consultation;

  @Index()
  @Column({ type: 'uuid' })
  buyerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'buyerId' })
  buyer?: User;

  /** What the student paid, in USD (the verified gateway payment). Held for the seller until the consultation ends (refunded to the student's card/bank if it is cancelled). */
  @Column({ type: 'double precision', default: 0 }) pricePaidUsd: number;

  /** The PaymentTransaction.reference that paid for this place. One payment can only ever create one enrolment. */
  @Index({ unique: true })
  @Column({ type: 'text', nullable: true, default: null })
  paymentReference?: string | null;

  /** LEGACY: places bought with tokens before consultations moved to the payment gateway. New enrolments leave this empty. */
  @Column({ type: 'int', nullable: true, default: null }) pricePaidTokens?: number | null;

  /** Set when the seller has been paid for this enrolment (at the end of the consultation). */
  @Column({ type: 'timestamptz', nullable: true }) paidOutAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
