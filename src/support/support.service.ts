import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SupportMessage, SupportTicket, TicketSource, TicketStatus, User } from '../entities';
import { assertValidId, escapeLike } from '../database/db-utils';
import { normalizeEmail } from '../entities/user.entity';
import { MailService } from '../mail/mail.service';
import { RealtimeService } from '../realtime/realtime.service';
import { ListTicketsQueryDto } from './support.dto';

export interface Actor {
  id: string;
  name: string;
}

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private config: ConfigService,
    private mail: MailService,
    private realtime: RealtimeService,
    @InjectRepository(SupportTicket) private tickets: Repository<SupportTicket>,
    @InjectRepository(SupportMessage) private messages: Repository<SupportMessage>,
    @InjectRepository(User) private users: Repository<User>,
  ) {}

  // ---------- creating tickets (visitor / user) ----------

  async createTicket(input: {
    userId?: string | null;
    name: string;
    email: string;
    subject: string;
    message: string;
    source: TicketSource;
  }) {
    const ticket = await this.tickets.save(
      this.tickets.create({
        userId: input.userId ?? null,
        name: input.name.trim(),
        email: normalizeEmail(input.email),
        subject: input.subject.trim() || 'General enquiry',
        source: input.source,
        status: 'OPEN',
        awaitingAdmin: true,
        unreadByUser: false,
      }),
    );
    const first = await this.messages.save(
      this.messages.create({ ticketId: ticket.id, sender: 'CUSTOMER', senderName: ticket.name, body: input.message.trim() }),
    );

    this.realtime.publish({
      type: 'ticket.new',
      ticket: { id: ticket.id, subject: ticket.subject, name: ticket.name, email: ticket.email, source: ticket.source },
    });
    this.notifyAdmins(ticket, first.body);
    return { ticket, messages: [first] };
  }

  /** Customer (registered user) adds a follow-up to their own ticket. */
  async customerReply(ticketId: string, userId: string, body: string) {
    const ticket = await this.requireOwnTicket(ticketId, userId);
    const user = await this.users.findOneBy({ id: userId });
    const msg = await this.messages.save(
      this.messages.create({
        ticketId,
        sender: 'CUSTOMER',
        senderName: ticket.name || user?.email || 'Customer',
        body: body.trim(),
      }),
    );
    await this.tickets.update({ id: ticketId }, { status: 'OPEN', awaitingAdmin: true });
    this.realtime.publish({ type: 'ticket.updated', ticket: { id: ticketId, status: 'OPEN', awaitingAdmin: true } });
    this.notifyAdmins(ticket, msg.body, true);
    return msg;
  }

  // ---------- a registered user's own tickets ----------

  listMine(userId: string) {
    assertValidId(userId, 'User');
    return this.tickets.find({ where: { userId }, order: { updatedAt: 'DESC' }, take: 100 });
  }

  async unreadCount(userId: string) {
    assertValidId(userId, 'User');
    return { unread: await this.tickets.count({ where: { userId, unreadByUser: true } }) };
  }

  async getMine(ticketId: string, userId: string) {
    const ticket = await this.requireOwnTicket(ticketId, userId);
    const messages = await this.messages.find({ where: { ticketId }, order: { createdAt: 'ASC' } });
    if (ticket.unreadByUser) {
      await this.tickets.update({ id: ticketId }, { unreadByUser: false });
      ticket.unreadByUser = false;
    }
    return { ticket, messages };
  }

  private async requireOwnTicket(ticketId: string, userId: string) {
    assertValidId(ticketId, 'Ticket');
    assertValidId(userId, 'User');
    const ticket = await this.tickets.findOneBy({ id: ticketId });
    if (!ticket) throw new NotFoundException('Ticket not found');
    if (ticket.userId !== userId) throw new ForbiddenException('This ticket belongs to another account');
    return ticket;
  }

  // ---------- admin side ----------

  async adminSummary() {
    const rows = await this.tickets
      .createQueryBuilder('t')
      .select('t.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.status')
      .getRawMany<{ status: string; count: string }>();
    const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
    const awaiting = await this.tickets.count({ where: { awaitingAdmin: true, status: 'OPEN' } });
    return { open: by.OPEN ?? 0, answered: by.ANSWERED ?? 0, closed: by.CLOSED ?? 0, awaitingReply: awaiting };
  }

  async adminList(q: ListTicketsQueryDto) {
    const page = Math.max(q.page ?? 1, 1);
    const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
    const qb = this.tickets.createQueryBuilder('t');
    if (q.status && q.status !== 'ALL') qb.andWhere('t.status = :status', { status: q.status });
    const search = q.search?.trim();
    if (search) {
      qb.andWhere('(t.subject ILIKE :like OR t.email ILIKE :like OR t.name ILIKE :like)', { like: `%${escapeLike(search)}%` });
    }
    // Tickets waiting on us first, then newest activity.
    qb.orderBy('t.awaitingAdmin', 'DESC').addOrderBy('t.updatedAt', 'DESC').skip((page - 1) * limit).take(limit);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit, pages: Math.max(Math.ceil(total / limit), 1) };
  }

  async adminGet(ticketId: string) {
    assertValidId(ticketId, 'Ticket');
    const ticket = await this.tickets.findOneBy({ id: ticketId });
    if (!ticket) throw new NotFoundException('Ticket not found');
    const messages = await this.messages.find({ where: { ticketId }, order: { createdAt: 'ASC' } });
    return { ticket, messages };
  }

  async adminReply(ticketId: string, admin: Actor, body: string) {
    assertValidId(ticketId, 'Ticket');
    const ticket = await this.tickets.findOneBy({ id: ticketId });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const msg = await this.messages.save(
      this.messages.create({ ticketId, sender: 'ADMIN', senderName: admin.name || 'Support', body: body.trim() }),
    );
    await this.tickets.update(
      { id: ticketId },
      { status: 'ANSWERED', awaitingAdmin: false, unreadByUser: Boolean(ticket.userId) },
    );
    this.realtime.publish({ type: 'ticket.updated', ticket: { id: ticketId, status: 'ANSWERED', awaitingAdmin: false } });

    // Visitors from the homepage form have no account, so the email IS their reply channel.
    const appUrl = (this.config.get<string>('FRONTEND_URL') || this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    const where = ticket.userId && appUrl ? `\n\nYou can also see this reply in the Helpdesk section of your account: ${appUrl}` : '';
    this.mail
      .sendNotification(
        ticket.email,
        `Re: ${ticket.subject}`,
        `Hi ${ticket.name.split(' ')[0] || 'there'},\n\n${msg.body}${where}\n\n- ${admin.name || 'Support'}, Sherpar Support`,
      )
      .catch(() => undefined);
    return msg;
  }

  async adminSetStatus(ticketId: string, status: TicketStatus) {
    assertValidId(ticketId, 'Ticket');
    const ticket = await this.tickets.findOneBy({ id: ticketId });
    if (!ticket) throw new NotFoundException('Ticket not found');
    await this.tickets.update({ id: ticketId }, { status, awaitingAdmin: status === 'OPEN' ? ticket.awaitingAdmin : false });
    this.realtime.publish({ type: 'ticket.updated', ticket: { id: ticketId, status, awaitingAdmin: status === 'OPEN' && ticket.awaitingAdmin } });
    return this.tickets.findOneBy({ id: ticketId });
  }

  // ---------- helpers ----------

  private notifyAdmins(ticket: SupportTicket, body: string, followUp = false) {
    const to =
      this.config.get<string>('SUPPORT_INBOX_EMAIL') ||
      (this.config.get<string>('SUPER_ADMIN_EMAILS') ?? '').split(',')[0]?.trim() ||
      this.config.get<string>('SUPER_ADMIN_EMAIL') ||
      (this.config.get<string>('ADMIN_EMAILS') ?? '').split(',')[0]?.trim() ||
      this.config.get<string>('ADMIN_EMAIL');
    if (!to) return;
    this.mail
      .sendNotification(
        to,
        `${followUp ? 'New reply on' : 'New support ticket'}: ${ticket.subject}`,
        `From: ${ticket.name} <${ticket.email}>\nVia: ${ticket.source}\n\n${body}\n\nReply from the admin dashboard (Helpdesk tab).`,
      )
      .catch((err) => this.logger.warn(`Admin notification failed: ${(err as Error).message}`));
  }
}
