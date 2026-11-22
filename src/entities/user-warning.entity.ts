import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

/** A warning an admin or super admin sent to a user (also delivered as a notification and an email). */
@Entity('user_warnings')
@Index(['userId', 'createdAt'])
export class UserWarning extends SerializableEntity {
  static readonly keepNull = ['flagId', 'issuedById'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'uuid', nullable: true, default: null }) issuedById?: string | null;
  @Column({ type: 'text' }) issuedByName: string;
  @Column({ type: 'uuid', nullable: true, default: null }) flagId?: string | null;
  @Column({ type: 'text' }) message: string;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
