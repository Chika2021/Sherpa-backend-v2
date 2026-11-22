import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Not, Repository } from 'typeorm';
import { Notification, NotificationType } from '../entities';
import { assertValidId } from '../database/db-utils';

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  /** Frontend route opened when the notification is clicked. */
  link?: string | null;
  meta?: Record<string, any> | null;
}

const KEEP_READ_DAYS = 60;
const MAX_PER_USER = 300;

/**
 * In-app notifications (the bell). Other services call `notify`: it never throws, because failing to tell the
 * user something must never break the payment, reply or sign-up that caused it.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(@InjectRepository(Notification) private notifications: Repository<Notification>) {}

  onModuleInit() {
    // Housekeeping once a day: drop old, already-read notifications so the table stays small.
    setInterval(() => void this.prune(), 24 * 60 * 60 * 1000).unref();
  }

  /** Creates one notification. Returns the row, or null if it could not be saved. */
  async notify(userId: string | null | undefined, input: NotificationInput): Promise<Notification | null> {
    if (!userId) return null;
    try {
      assertValidId(userId, 'User');
      return await this.notifications.save(
        this.notifications.create({
          userId,
          type: input.type,
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 1000),
          link: input.link ?? null,
          meta: input.meta ?? null,
        }),
      );
    } catch (err) {
      this.logger.warn(`Could not create a notification for ${userId}: ${(err as Error).message}`);
      return null;
    }
  }

  /** The same notification for several users (admin alerts). */
  async notifyMany(userIds: string[], input: NotificationInput): Promise<void> {
    await Promise.all([...new Set(userIds)].map((id) => this.notify(id, input)));
  }

  async list(userId: string, opts: { limit?: number; unreadOnly?: boolean; before?: string } = {}) {
    assertValidId(userId, 'User');
    const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 100);
    const where: Record<string, any> = { userId };
    if (opts.unreadOnly) where.readAt = IsNull();
    if (opts.before) {
      const d = new Date(opts.before);
      if (!Number.isNaN(d.getTime())) where.createdAt = LessThan(d);
    }
    const [items, unread] = await Promise.all([
      this.notifications.find({ where, order: { createdAt: 'DESC' }, take: limit }),
      this.notifications.count({ where: { userId, readAt: IsNull() } }),
    ]);
    return { items, unread };
  }

  async unreadCount(userId: string) {
    assertValidId(userId, 'User');
    return { unread: await this.notifications.count({ where: { userId, readAt: IsNull() } }) };
  }

  async markRead(userId: string, id: string) {
    assertValidId(userId, 'User');
    assertValidId(id, 'Notification');
    const res = await this.notifications.update({ id, userId, readAt: IsNull() }, { readAt: new Date() });
    if (!res.affected) {
      const exists = await this.notifications.existsBy({ id, userId });
      if (!exists) throw new NotFoundException('Notification not found');
    }
    return this.unreadCount(userId);
  }

  async markAllRead(userId: string) {
    assertValidId(userId, 'User');
    await this.notifications.update({ userId, readAt: IsNull() }, { readAt: new Date() });
    return { unread: 0 };
  }

  async remove(userId: string, id: string) {
    assertValidId(userId, 'User');
    assertValidId(id, 'Notification');
    await this.notifications.delete({ id, userId });
    return this.unreadCount(userId);
  }

  /** Deletes every notification the user has already read. */
  async clearRead(userId: string) {
    assertValidId(userId, 'User');
    await this.notifications.delete({ userId, readAt: Not(IsNull()) });
    return this.unreadCount(userId);
  }

  private async prune() {
    try {
      const cutoff = new Date(Date.now() - KEEP_READ_DAYS * 24 * 60 * 60 * 1000);
      await this.notifications.delete({ readAt: Not(IsNull()), createdAt: LessThan(cutoff) });

      // Safety net: nobody keeps more than MAX_PER_USER, whatever their read state.
      const heavy: Array<{ userId: string }> = await this.notifications.query(
        `SELECT "userId" FROM notifications GROUP BY "userId" HAVING COUNT(*) > $1 LIMIT 200`,
        [MAX_PER_USER],
      );
      for (const { userId } of heavy) {
        const keep = await this.notifications.find({ where: { userId }, order: { createdAt: 'DESC' }, take: MAX_PER_USER, select: { id: true } });
        const keepIds = keep.map((k) => k.id);
        if (keepIds.length) {
          await this.notifications
            .createQueryBuilder()
            .delete()
            .where('"userId" = :userId AND id NOT IN (:...keepIds)', { userId, keepIds })
            .execute();
        }
      }
    } catch (err) {
      this.logger.warn(`Notification clean-up failed: ${(err as Error).message}`);
    }
  }

  /** Marks the unread notifications that point at one thing (e.g. a helpdesk ticket) as read once the user opens it. */
  async markReadByMeta(userId: string, meta: { ticketId?: string }) {
    if (!meta.ticketId) return;
    try {
      await this.notifications
        .createQueryBuilder()
        .update()
        .set({ readAt: new Date() })
        .where('"userId" = :userId AND "readAt" IS NULL AND meta ->> \'ticketId\' = :ticketId', { userId, ticketId: meta.ticketId })
        .execute();
    } catch {
      // best-effort
    }
  }
}

