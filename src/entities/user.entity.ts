import { BeforeInsert, BeforeUpdate, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';

@Entity('users')
export class User extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Always stored trimmed + lower-cased (see normalizeEmail) - the old
  // Mongoose schema did this with `lowercase: true, trim: true`, and every
  // lookup by email relies on it.
  @Index({ unique: true })
  @Column({ type: 'text' })
  email: string;

  @Column({ type: 'text' })
  passwordHash: string;

  @Column({ type: 'text', nullable: true }) firstName?: string;
  @Column({ type: 'text', nullable: true }) lastName?: string;
  @Column({ type: 'text', nullable: true }) phone?: string;
  @Column({ type: 'text', nullable: true }) location?: string;
  @Column({ type: 'text', nullable: true }) linkedinUrl?: string;
  @Column({ type: 'text', nullable: true }) portfolioUrl?: string;

  // Wallet balance. Tokens are bought at the rate in
  // src/tokens/token-pricing.config.ts ($3 = 5 tokens by default) and spent
  // at 1 token per AI generation. New accounts are credited
  // FREE_SIGNUP_TOKENS by AuthService.register, which also writes the
  // matching BONUS ledger row - hence the 0 default here.
  @Column({ type: 'double precision', default: 0 })
  tokens: number;

  // Set by AuthService.forgotPassword, cleared on successful reset (or left
  // to expire). The raw token is emailed to the user - only its hash is ever
  // stored. Never returned to clients.
  @Column({ type: 'text', nullable: true }) passwordResetTokenHash?: string | null;
  @Column({ type: 'timestamptz', nullable: true }) passwordResetExpiresAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;

  @BeforeInsert()
  @BeforeUpdate()
  private normalizeEmail() {
    if (typeof this.email === 'string') this.email = this.email.trim().toLowerCase();
  }
}

/** Same normalisation the old Mongoose `lowercase`/`trim` setters applied to every email filter. */
export function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}
