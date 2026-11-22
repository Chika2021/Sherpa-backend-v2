import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

export const NOTIFICATION_TYPES = ['PAYMENT', 'MESSAGE', 'REFERRAL', 'TOKENS', 'WARNING', 'ACCOUNT', 'FLAG', 'SYSTEM'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** One in-app notification for one user (the bell in the app header). `FLAG` ones go to admins and super admins. */
@Entity('notifications')
@Index(['userId', 'createdAt'])
@Index(['userId', 'readAt'])
export class Notification extends SerializableEntity {
  static readonly keepNull = ['link', 'readAt', 'meta'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'text' }) type: NotificationType;
  @Column({ type: 'text' }) title: string;
  @Column({ type: 'text' }) body: string;

  /** Frontend route to open when the notification is clicked, e.g. "/billing". */
  @Column({ type: 'text', nullable: true, default: null }) link?: string | null;

  /** Null until the user has seen it. */
  @Column({ type: 'timestamptz', nullable: true, default: null }) readAt?: Date | null;

  @Column({ type: 'jsonb', nullable: true, default: null }) meta?: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
