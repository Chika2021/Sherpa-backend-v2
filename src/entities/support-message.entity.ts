import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { SerializableEntity } from './serializable.entity';
import { SupportTicket } from './support-ticket.entity';

export type SupportSender = 'CUSTOMER' | 'ADMIN';

@Entity('support_messages')
@Index(['ticketId', 'createdAt'])
export class SupportMessage extends SerializableEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  ticketId: string;

  @ManyToOne(() => SupportTicket, (t) => t.messages, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ticketId' })
  ticket?: SupportTicket;

  @Column({ type: 'text' })
  sender: SupportSender;

  // Display name of whoever wrote it (customer name, or the admin's name).
  @Column({ type: 'text' }) senderName: string;

  @Column({ type: 'text' }) body: string;

  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date;
}
