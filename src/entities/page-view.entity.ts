import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';

/**
 * One page opened by one signed-in user - what the super admin's "pages" reports read.
 *  - `path`    the page as the user saw it, e.g. /dashboard/jobs/6f1c...-uuid (query string and #hash removed).
 *  - `pattern` the same page with ids replaced, e.g. /dashboard/jobs/:id - so "most visited" groups every
 *              job's page into one row instead of thousands.
 * Written by PageTrackerService when the frontend calls POST /analytics/page-view on every route change.
 */
@Entity('page_views')
@Index(['userId', 'createdAt'])
@Index(['pattern', 'createdAt'])
export class PageView extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'text' })
  path: string;

  @Column({ type: 'text' })
  pattern: string;

  @Column({ type: 'text', nullable: true })
  title?: string | null;

  @Index()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
