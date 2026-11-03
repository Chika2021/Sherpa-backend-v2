import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

/**
 * A user-supplied login (and optionally signup) credential for a specific
 * job site/ATS domain, used by the auto-apply pipeline to sign in before
 * attempting to fill out an application form.
 *
 * The password is NEVER stored in plaintext - only `encryptedPassword`
 * (AES-256-GCM via EncryptionService) is persisted, and it is only decrypted
 * in-memory, inside CredentialsService, for the duration of a single
 * auto-apply attempt. It is never returned from any controller endpoint.
 */
@Entity('site_credentials')
@Index(['userId', 'domain'], { unique: true })
export class SiteCredential extends SerializableEntity {
  static readonly keepNull = ['lastUsedAt'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  // Hostname this credential applies to, e.g. "boards.greenhouse.io" or
  // "myworkdayjobs.com" (matched as a suffix). Stored trimmed + lower-cased.
  @Column({ type: 'text' })
  domain: string;

  // Human-friendly label shown in the UI, e.g. "Greenhouse - Acme Corp".
  @Column({ type: 'text', nullable: true }) label?: string;

  @Column({ type: 'text' }) username: string; // usually an email
  @Column({ type: 'text' }) encryptedPassword: string;

  // Where to find the login form, when it isn't reachable by just visiting
  // the job's apply URL itself. Optional.
  @Column({ type: 'text', nullable: true }) loginUrl?: string;

  // Where to find the signup/registration form. Only used when
  // autoSignupIfMissing is true and a login attempt fails.
  @Column({ type: 'text', nullable: true }) signupUrl?: string;

  // Opt-in per site: if true and login fails, attempt a best-effort signup.
  @Column({ type: 'boolean', default: false }) autoSignupIfMissing: boolean;

  @Column({ type: 'timestamptz', nullable: true, default: null }) lastUsedAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
