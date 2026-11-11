import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { User } from './user.entity';
import { SupportMessage } from './support-message.entity';

export const TICKET_STATUSES = ['OPEN', 'ANSWERED', 'CLOSED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_SOURCES = ['CONTACT_FORM', 'HELPDESK', 'CHATBOT'] as const;
export type TicketSource = (typeof TICKET_SOURCES)[number];

/** One helpdesk conversation: created by the homepage contact form, the in-app helpdesk, or a chatbot hand-off. */
@Entity('support_tickets')
@Index(['status', 'updatedAt'])
export class SupportTicket extends SerializableEntity {
  static readonly keepNull = ['userId'];

  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Null for visitors who are not registered (homepage contact form).
  @Index()
  @Column({ type: 'uuid', nullable: true, default: null })
  userId?: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: User;

  @Column({ type: 'text' }) name: string;
  @Column({ type: 'text' }) email: string;
  @Column({ type: 'text' }) subject: string;

  @Column({ type: 'text', default: 'OPEN' })
  status: TicketStatus;

  @Column({ type: 'text', default: 'CONTACT_FORM' })
  source: TicketSource;

  // True when the latest message is from the customer and an admin hasn't answered yet.
  @Column({ type: 'boolean', default: true })
  awaitingAdmin: boolean;

  // True when an admin replied and the registered user hasn't opened the ticket since.
  @Column({ type: 'boolean', default: false })
  unreadByUser: boolean;

  @OneToMany(() => SupportMessage, (m) => m.ticket)
  messages?: SupportMessage[];

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updatedAt: Date;
}
