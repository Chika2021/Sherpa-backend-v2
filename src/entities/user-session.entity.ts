import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

/**
 * One visit to the app by one user - what the super admin's "activity" dashboard reads.
 *
 *  - A row is created when someone signs in (source LOGIN), or when someone who is still signed in
 *    (the access token lasts days) comes back after being idle for a while (source RETURN).
 *  - `lastSeenAt` moves forward while the user keeps using the app (any authenticated request, or the
 *    heartbeat), so  lastSeenAt - loginAt  is how long they stayed.
 *  - `endedAt` is set only when the app calls POST /auth/logout (or the user signs in again). When it is
 *    null the visit ended whenever `lastSeenAt` stopped moving.
 * Written by SessionTrackerService; never blocks or fails a request.
 */
export const USER_SESSION_SOURCES = ['LOGIN', 'RETURN'] as const;
export type UserSessionSource = (typeof USER_SESSION_SOURCES)[number];

@Entity('user_sessions')
@Index(['userId', 'lastSeenAt'])
export class UserSession extends SerializableEntity {
  static readonly keepNull = ['endedAt'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Index()
  @Column({ type: 'timestamptz' })
  loginAt: Date;

  @Column({ type: 'timestamptz' })
  lastSeenAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endedAt?: Date | null;

  @Column({ type: 'text', default: 'LOGIN' })
  source: UserSessionSource;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
