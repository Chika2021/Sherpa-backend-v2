import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { UserSession } from '../entities/user-session.entity';

/** No activity for this long = the visit is over; the next request starts a new one. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** lastSeenAt is written at most this often per user, so busy users don't cause a write per request. */
const WRITE_EVERY_MS = 30 * 1000;
/** Requests that arrive right after a logout (in flight, retries) must not open a new visit. */
const POST_LOGOUT_GRACE_MS = 15 * 1000;
/** The super admin is the one watching the dashboard - their own activity is not tracked. */
const UNTRACKED_ROLES = new Set(['SUPER_ADMIN']);

interface Live {
  sessionId: string;
  lastSeen: number;
  lastWrite: number;
  endedAt?: number;
}

/**
 * Records when users sign in and how long they stay (see UserSession). Every method is best-effort:
 * tracking can fail, but it must never fail or slow down a login or an API call, so errors are logged
 * and swallowed and callers don't await it.
 */
@Injectable()
export class SessionTrackerService {
  private readonly logger = new Logger(SessionTrackerService.name);
  private readonly live = new Map<string, Live>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(@InjectRepository(UserSession) private sessions: Repository<UserSession>) {}

  private tracked(role?: string | null) {
    return !UNTRACKED_ROLES.has(role ?? 'USER');
  }

  /** A successful sign-in (or registration): always a fresh visit. Any visit still open for this user is closed first. */
  startLogin(user: { id: string; role?: string | null }): Promise<void> {
    if (!this.tracked(user.role)) return Promise.resolve();
    // Registered as in-flight so the first request made with the new token waits for this row
    // instead of opening a second visit of its own.
    const p = this.recordLogin(user).finally(() => this.inflight.delete(user.id));
    this.inflight.set(user.id, p);
    return p;
  }

  private async recordLogin(user: { id: string; role?: string | null }): Promise<void> {
    try {
      const now = new Date();
      // Close earlier open visits at their last activity, so two visits never overlap and double-count time.
      await this.sessions
        .createQueryBuilder()
        .update(UserSession)
        .set({ endedAt: () => '"lastSeenAt"' })
        .where('"userId" = :id AND "endedAt" IS NULL', { id: user.id })
        .execute();
      const row = await this.sessions.save(
        this.sessions.create({ userId: user.id, loginAt: now, lastSeenAt: now, endedAt: null, source: 'LOGIN' }),
      );
      this.remember(user.id, { sessionId: row.id, lastSeen: now.getTime(), lastWrite: now.getTime() });
    } catch (err) {
      this.logger.warn(`Could not record login for ${user.id}: ${(err as Error).message}`);
    }
  }

  /** Called for every authenticated request: keeps the current visit alive, or starts one after an idle gap. */
  touch(user: { id: string; role?: string | null }): Promise<void> {
    if (!this.tracked(user.role)) return Promise.resolve();
    const now = Date.now();
    const known = this.live.get(user.id);

    if (known?.endedAt && now - known.endedAt < POST_LOGOUT_GRACE_MS) return Promise.resolve();

    // A login or a resume for this user is being written right now - wait for it rather than race it.
    const pending = this.inflight.get(user.id);
    if (pending) return pending;

    // Hot path: a visit we already know is open. Memory only, plus a throttled write.
    if (known && !known.endedAt && now - known.lastSeen < SESSION_IDLE_MS) {
      known.lastSeen = now;
      if (now - known.lastWrite < WRITE_EVERY_MS) return Promise.resolve();
      known.lastWrite = now;
      return this.sessions
        .update({ id: known.sessionId }, { lastSeenAt: new Date(now) })
        .then(() => undefined)
        .catch((err) => this.logger.warn(`Could not update activity for ${user.id}: ${err.message}`));
    }

    // Cold path (first request since a restart, or after an idle gap). One at a time per user, so a burst
    // of parallel requests can't open several visits.
    const p = this.resume(user.id, now)
      .catch((err) => this.logger.warn(`Could not track activity for ${user.id}: ${err.message}`))
      .finally(() => this.inflight.delete(user.id));
    this.inflight.set(user.id, p);
    return p;
  }

  private async resume(userId: string, now: number): Promise<void> {
    const last = await this.sessions.findOne({ where: { userId }, order: { lastSeenAt: 'DESC' } });
    if (last && !last.endedAt && now - last.lastSeenAt.getTime() < SESSION_IDLE_MS) {
      await this.sessions.update({ id: last.id }, { lastSeenAt: new Date(now) });
      this.remember(userId, { sessionId: last.id, lastSeen: now, lastWrite: now });
      return;
    }
    const at = new Date(now);
    const row = await this.sessions.save(
      this.sessions.create({ userId, loginAt: at, lastSeenAt: at, endedAt: null, source: 'RETURN' }),
    );
    this.remember(userId, { sessionId: row.id, lastSeen: now, lastWrite: now });
  }

  /** The app signed out: stamp the exact end of the visit. */
  async end(userId: string): Promise<void> {
    try {
      const now = new Date();
      await this.sessions.update({ userId, endedAt: IsNull() }, { endedAt: now, lastSeenAt: now });
      const known = this.live.get(userId);
      this.live.set(userId, { sessionId: known?.sessionId ?? '', lastSeen: now.getTime(), lastWrite: now.getTime(), endedAt: now.getTime() });
    } catch (err) {
      this.logger.warn(`Could not record logout for ${userId}: ${(err as Error).message}`);
    }
  }

  private remember(userId: string, entry: Live) {
    if (this.live.size > 10_000) {
      const cutoff = Date.now() - SESSION_IDLE_MS;
      for (const [id, e] of this.live) if (e.lastSeen < cutoff) this.live.delete(id);
    }
    this.live.set(userId, entry);
  }
}
