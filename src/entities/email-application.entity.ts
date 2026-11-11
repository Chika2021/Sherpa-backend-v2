import { Column, CreateDateColumn, Entity, Index, JoinColumn, OneToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { Application } from './application.entity';
import { EmailApplicationStatus } from './enums';

/**
 * The email side of an application made "by email": the AI-drafted (and user-edited) message, who it goes
 * to, and whether it has been sent. One row per Application (the Application holds the job and the generated
 * resume + cover letter that get attached). Deleting the application deletes this row too.
 */
@Entity('email_applications')
export class EmailApplication extends SerializableEntity {
  static readonly keepNull = ['recipientEmail', 'sentAt', 'sendError'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  // One row per application: the OneToOne below makes this column unique.
  @Column({ type: 'uuid' })
  applicationId: string;

  @OneToOne(() => Application, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'applicationId' })
  application?: Application;

  // Where the application goes. Optional while drafting; required to send.
  @Column({ type: 'text', nullable: true, default: null }) recipientEmail?: string | null;
  // Optional hiring-manager name, used for the greeting when the draft is (re)written.
  @Column({ type: 'text', nullable: true }) recipientName?: string | null;

  @Column({ type: 'text' }) subject: string;
  @Column({ type: 'text' }) body: string;

  @Column({ type: 'text', default: 'DRAFT' })
  status: EmailApplicationStatus;

  @Column({ type: 'timestamptz', nullable: true, default: null }) sentAt?: Date | null;
  // Short, user-safe reason the last send failed.
  @Column({ type: 'text', nullable: true, default: null }) sendError?: string | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
