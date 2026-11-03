import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

export const TRANSACTION_STATUSES = ['PENDING', 'SUCCESS', 'FAILED', 'ABANDONED'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/** One real-money token purchase through Paystack. */
@Entity('payment_transactions')
export class PaymentTransaction extends SerializableEntity {
  static readonly keepNull = ['packageId', 'purposeRef', 'paystackData'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  // Our own reference, sent to Paystack and used to look the transaction back
  // up from both the webhook and the "verify on return" flow.
  @Index({ unique: true })
  @Column({ type: 'text' })
  reference: string;

  @Column({ type: 'double precision' }) tokensRequested: number;
  @Column({ type: 'double precision', default: 0 }) tokensAwarded: number;

  // Which bundle was bought, if any (see src/tokens/token-pricing.config.ts) -
  // null for a custom token/dollar amount.
  @Column({ type: 'text', nullable: true, default: null }) packageId?: string | null;

  // The per-token USD rate in force at purchase time, kept for audit so old
  // transactions still read correctly after a price change.
  @Column({ type: 'double precision' }) pricePerTokenUsd: number;

  // Price in USD (tokensRequested * pricePerTokenUsd)...
  @Column({ type: 'double precision' }) amountUsd: number;

  // ...and the amount actually charged, in `currency`'s major unit (e.g. naira,
  // not kobo) after FX conversion. Equal to amountUsd when currency is USD.
  @Column({ type: 'double precision' }) amount: number;
  @Column({ type: 'text' }) currency: string;

  @Column({ type: 'text', default: 'PENDING' })
  status: TransactionStatus;

  // What this payment is FOR. 'TOKENS' buys wallet tokens. 'INTERNSHIP_DOCUMENT'
  // pays for the downloadable internship document of one skill course: no
  // tokens are credited, and `purposeRef` is that SkillTutorial's id.
  @Index()
  @Column({ type: 'text', default: 'TOKENS' })
  purpose: 'TOKENS' | 'INTERNSHIP_DOCUMENT';

  @Index()
  @Column({ type: 'text', nullable: true, default: null })
  purposeRef?: string | null;

  // Raw response body from Paystack's verify endpoint, kept for audit/support.
  @Column({ type: 'jsonb', nullable: true, default: null })
  paystackData?: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
