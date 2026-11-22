import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

/**
 *  PENDING    the friend signed up through the link; the referrer has earned nothing yet
 *  VERIFIED   the friend verified their email; the referrer got the verification reward
 *  PURCHASED  the friend made their first purchase; the referrer also got the purchase reward
 *  REJECTED   not rewarded: a self-referral, an abuse block, or reversed by an admin (see `rejectedReason`)
 */
export const REFERRAL_STATUSES = ['PENDING', 'VERIFIED', 'PURCHASED', 'REJECTED'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** One row per referred user. `referredUserId` is unique, which is what makes "a user can only be referred once" a database rule. */
@Entity('referrals')
@Index(['referrerId', 'createdAt'])
export class Referral extends SerializableEntity {
  static readonly keepNull = ['rejectedReason', 'verifyRewardedAt', 'purchaseRewardedAt', 'reversedAt'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  referrerId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referrerId' })
  referrer?: User;

  @Index({ unique: true })
  @Column({ type: 'uuid' })
  referredUserId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'referredUserId' })
  referred?: User;

  /** The code that was used (kept even if the referrer's code changes later). */
  @Column({ type: 'text' }) code: string;

  @Index()
  @Column({ type: 'text', default: 'PENDING' })
  status: ReferralStatus;

  /** Extra tokens the friend got at signup for using the link. */
  @Column({ type: 'double precision', default: 0 }) signupBonusTokens: number;

  /** Reward paid to the referrer for the friend's email verification (counts towards the per-referrer cap). */
  @Column({ type: 'double precision', default: 0 }) verifyRewardTokens: number;
  @Column({ type: 'timestamptz', nullable: true, default: null }) verifyRewardedAt?: Date | null;

  /** Reward paid to the referrer for the friend's first purchase (uncapped). */
  @Column({ type: 'double precision', default: 0 }) purchaseRewardTokens: number;
  @Column({ type: 'timestamptz', nullable: true, default: null }) purchaseRewardedAt?: Date | null;

  @Column({ type: 'text', nullable: true, default: null }) rejectedReason?: string | null;
  @Column({ type: 'timestamptz', nullable: true, default: null }) reversedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
