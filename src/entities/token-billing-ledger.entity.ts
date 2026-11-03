import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

/**
 * Every movement of a user's token balance, in one place:
 *  - PURCHASE   tokens bought with real money (credited by PaymentsService)
 *  - BONUS      free tokens granted by us (signup bonus, goodwill, promos)
 *  - USAGE      tokens spent on an AI generation (debited by TokensService)
 *  - REFUND     tokens handed back after a failed/disputed charge
 *  - ADJUSTMENT manual correction by an admin
 */
export const TOKEN_LEDGER_ENTRY_TYPES = ['PURCHASE', 'BONUS', 'USAGE', 'REFUND', 'ADJUSTMENT'] as const;
export type TokenLedgerEntryType = (typeof TOKEN_LEDGER_ENTRY_TYPES)[number];

/**
 * The full token ledger under the current billing model ($3 = 5 tokens,
 * 1 token per AI generation - see src/tokens/token-pricing.config.ts).
 *
 * Sign convention: `tokens` and `usdValue` are POSITIVE for credits
 * (PURCHASE/BONUS/REFUND) and NEGATIVE for debits (USAGE), so a plain
 * SUM over any slice of a user's ledger reconciles against their balance.
 */
@Entity('token_billing_ledger')
@Index(['userId', 'createdAt'])
@Index(['userId', 'entryType', 'createdAt'])
export class TokenBillingLedger extends SerializableEntity {
  static readonly keepNull = ['label', 'model', 'reference'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Index()
  @Column({ type: 'text' })
  entryType: TokenLedgerEntryType;

  /** Signed token delta: positive = credited, negative = spent. */
  @Column({ type: 'double precision' }) tokens: number;

  /** Signed USD value of `tokens` at the rate in force when the row was written. */
  @Column({ type: 'double precision' }) usdValue: number;

  /** The per-token USD rate used for `usdValue`, kept for audit as prices change. */
  @Column({ type: 'double precision' }) pricePerTokenUsd: number;

  /** The user's balance immediately after this entry was applied. */
  @Column({ type: 'double precision' }) balanceAfter: number;

  /** What caused this entry (feature breadcrumb for USAGE rows; package id or "custom" for PURCHASE). */
  @Column({ type: 'text', nullable: true, default: null }) label: string | null;

  /** Gemini model that served the call, on USAGE rows only. Informational. */
  @Column({ type: 'text', nullable: true, default: null }) model: string | null;

  /** Paystack transaction reference on PURCHASE/REFUND rows. */
  @Index()
  @Column({ type: 'text', nullable: true, default: null }) reference: string | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
