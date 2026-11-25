import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { assertValidId, escapeLike } from '../database/db-utils';
import { SESSION_IDLE_MS } from '../auth/session-tracker.service';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ONLINE_WITHIN_MS = 5 * 60 * 1000;
const MAX_RANGE_DAYS = 366;
const MAX_SESSIONS_PER_DAY = 5000;

/** Seconds a visit lasted: until the logout if there was one, otherwise until the last activity. */
const DURATION_SQL = `GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(s."endedAt", s."lastSeenAt") - s."loginAt")))`;

const round1 = (n: number) => Math.round(n * 10) / 10;

function humanDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return s <= 0 ? 'under a minute' : `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** What the super admin's activity dashboard reads: who logged in each day, when, and how long they stayed. */
@Injectable()
export class ActivityService {
  constructor(
    @InjectDataSource() private ds: DataSource,
    private config: ConfigService,
  ) {}

  // ---------------------------------------------------------------- helpers

  /** Days are cut at midnight in this timezone. `?tz=` per request, else ACTIVITY_TIMEZONE, else UTC. */
  resolveTz(tz?: string): string {
    const zone = (tz?.trim() || this.config.get<string>('ACTIVITY_TIMEZONE') || 'UTC').trim();
    try {
      new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    } catch {
      throw new BadRequestException(`Unknown timezone "${zone}". Use an IANA name like Africa/Lagos or UTC.`);
    }
    return zone;
  }

  today(tz: string): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // YYYY-MM-DD
  }

  parseDate(value: string | undefined, label: string): string | undefined {
    if (value === undefined || value === '') return undefined;
    const ok = DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
    if (!ok) throw new BadRequestException(`${label} must be a real date written YYYY-MM-DD.`);
    return value;
  }

  addDays(date: string, n: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  clock(date: Date | null | undefined, tz: string): string | null {
    if (!date) return null;
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  private shape(row: any, tz: string, now: number) {
    const loginAt: Date = row.loginAt;
    const lastSeenAt: Date = row.lastSeenAt;
    const endedAt: Date | null = row.endedAt ?? null;
    const seconds = Math.max(0, ((endedAt ?? lastSeenAt).getTime() - loginAt.getTime()) / 1000);
    return {
      id: row.id,
      source: row.source as 'LOGIN' | 'RETURN',
      loginAt,
      loginTime: this.clock(loginAt, tz),
      lastSeenAt,
      endedAt,
      leftTime: this.clock(endedAt ?? lastSeenAt, tz),
      durationSeconds: Math.round(seconds),
      duration: humanDuration(seconds),
      online: !endedAt && now - lastSeenAt.getTime() < ONLINE_WITHIN_MS,
    };
  }

  // ---------------------------------------------------------------- reports

  /**
   * One row per day: how many different users were active, how many visits, and how long they stayed in total.
   * Defaults to the last 14 days. Days with no activity are included as zeros so a chart has no gaps.
   */
  async daily(query: { from?: string; to?: string; tz?: string }) {
    const tz = this.resolveTz(query.tz);
    const to = this.parseDate(query.to, 'to') ?? this.today(tz);
    const from = this.parseDate(query.from, 'from') ?? this.addDays(to, -13);
    if (from > to) throw new BadRequestException('"from" must not be after "to".');
    if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestException(`Pick a range of at most ${MAX_RANGE_DAYS} days.`);
    }

    const rows: Array<{ day: string; users: number; sessions: number; logins: number; seconds: number }> = await this.ds.query(
      `SELECT to_char(s."loginAt" AT TIME ZONE $1::text, 'YYYY-MM-DD') AS day,
              COUNT(DISTINCT s."userId")::int AS users,
              COUNT(*)::int AS sessions,
              (COUNT(*) FILTER (WHERE s.source = 'LOGIN'))::int AS logins,
              COALESCE(SUM(${DURATION_SQL}), 0)::float AS seconds
         FROM user_sessions s
        WHERE s."loginAt" >= ($2::date)::timestamp AT TIME ZONE $1::text
          AND s."loginAt" <  (($3::date + 1))::timestamp AT TIME ZONE $1::text
        GROUP BY 1`,
      [tz, from, to],
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));

    const days: Array<Record<string, any>> = [];
    for (let d = to; d >= from; d = this.addDays(d, -1)) {
      const r = byDay.get(d);
      const sessions = r?.sessions ?? 0;
      const seconds = r?.seconds ?? 0;
      days.push({
        date: d,
        uniqueUsers: r?.users ?? 0,
        logins: r?.logins ?? 0,
        sessions,
        totalMinutes: round1(seconds / 60),
        avgMinutesPerSession: sessions ? round1(seconds / 60 / sessions) : 0,
      });
    }
    return { timezone: tz, from, to, days };
  }

  /**
   * Everyone who was in the app on one day (default today): for each user the time they first logged in,
   * when they were last seen, how long they stayed in total, and each individual visit.
   * Filters: ?search= (email / name), ?role=.
   */
  async day(query: { date?: string; tz?: string; search?: string; role?: string }) {
    const tz = this.resolveTz(query.tz);
    const date = this.parseDate(query.date, 'date') ?? this.today(tz);

    const params: any[] = [date, tz];
    let extra = '';
    const search = query.search?.trim();
    if (search) {
      params.push(`%${escapeLike(search)}%`);
      extra += ` AND (u.email ILIKE $${params.length} OR concat_ws(' ', u."firstName", u."lastName") ILIKE $${params.length})`;
    }
    if (query.role?.trim()) {
      params.push(query.role.trim().toUpperCase());
      extra += ` AND u.role = $${params.length}`;
    }

    const rows: any[] = await this.ds.query(
      `SELECT s.id, s."userId", s."loginAt", s."lastSeenAt", s."endedAt", s.source,
              u.email, u."firstName", u."lastName", u.role
         FROM user_sessions s
         JOIN users u ON u.id = s."userId"
        WHERE s."loginAt" >= ($1::date)::timestamp AT TIME ZONE $2::text
          AND s."loginAt" <  (($1::date + 1))::timestamp AT TIME ZONE $2::text
          ${extra}
        ORDER BY s."loginAt" ASC
        LIMIT ${MAX_SESSIONS_PER_DAY}`,
      params,
    );

    const now = Date.now();
    const users = new Map<string, any>();
    for (const row of rows) {
      const session = this.shape(row, tz, now);
      let u = users.get(row.userId);
      if (!u) {
        u = {
          userId: row.userId,
          email: row.email,
          name: [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email,
          role: row.role,
          firstLoginAt: session.loginAt,
          firstLoginTime: session.loginTime,
          lastSeenAt: session.lastSeenAt,
          lastSeenTime: this.clock(session.lastSeenAt, tz),
          sessionCount: 0,
          totalSeconds: 0,
          online: false,
          sessions: [],
        };
        users.set(row.userId, u);
      }
      u.sessionCount += 1;
      u.totalSeconds += session.durationSeconds;
      if (session.lastSeenAt > u.lastSeenAt) {
        u.lastSeenAt = session.lastSeenAt;
        u.lastSeenTime = this.clock(session.lastSeenAt, tz);
      }
      u.online = u.online || session.online;
      u.sessions.push(session);
    }

    const list = [...users.values()]
      .map(({ totalSeconds, ...u }) => ({ ...u, totalMinutes: round1(totalSeconds / 60), totalDuration: humanDuration(totalSeconds) }))
      .sort((a, b) => a.firstLoginAt.getTime() - b.firstLoginAt.getTime());
    const totalSeconds = [...users.values()].reduce((n, u) => n + u.totalSeconds, 0);

    return {
      timezone: tz,
      date,
      totals: {
        uniqueUsers: list.length,
        sessions: rows.length,
        totalMinutes: round1(totalSeconds / 60),
        onlineNow: list.filter((u) => u.online).length,
      },
      truncated: rows.length >= MAX_SESSIONS_PER_DAY,
      idleTimeoutMinutes: SESSION_IDLE_MS / 60_000,
      users: list,
    };
  }

  /** The most recent visits of ONE user (newest first), for the user's detail view. */
  async forUser(userId: string, query: { limit?: string; tz?: string }) {
    assertValidId(userId, 'User');
    const tz = this.resolveTz(query.tz);
    const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 200);
    const rows: any[] = await this.ds.query(
      `SELECT s.id, s."loginAt", s."lastSeenAt", s."endedAt", s.source,
              to_char(s."loginAt" AT TIME ZONE $2::text, 'YYYY-MM-DD') AS date
         FROM user_sessions s
        WHERE s."userId" = $1
        ORDER BY s."loginAt" DESC
        LIMIT ${limit}`,
      [userId, tz],
    );
    const now = Date.now();
    const sessions = rows.map((r) => ({ date: r.date, ...this.shape(r, tz, now) }));
    return { timezone: tz, sessions };
  }

  // ---------------------------------------------------------------- storage & cleanup

  /** How much room the activity data takes: rows, size on disk and oldest record, for page views and for login visits. */
  async storage() {
    const [r]: any[] = await this.ds.query(
      `SELECT (SELECT COUNT(*) FROM page_views)::int AS pv_rows,
              pg_total_relation_size('page_views')::float AS pv_bytes,
              (SELECT MIN("createdAt") FROM page_views) AS pv_oldest,
              (SELECT COUNT(*) FROM user_sessions)::int AS vs_rows,
              pg_total_relation_size('user_sessions')::float AS vs_bytes,
              (SELECT MIN("loginAt") FROM user_sessions) AS vs_oldest`,
    );
    return {
      pageViews: { rows: r.pv_rows, bytes: Math.round(r.pv_bytes), oldest: r.pv_oldest ?? null },
      logins: { rows: r.vs_rows, bytes: Math.round(r.vs_bytes), oldest: r.vs_oldest ?? null },
      totalBytes: Math.round(r.pv_bytes + r.vs_bytes),
    };
  }

  /**
   * Deletes recorded activity to free database space. Super admin only, and refused unless ?confirm=DELETE.
   *   target         all (default) | pages (page views only) | logins (login visits only)
   *   olderThanDays  omit for EVERYTHING, or a number of days to keep only the most recent ones
   * Visits that are still open (the user is online right now) are always kept, so live tracking is not disturbed.
   * Page views are not part of any report except the activity pages, so nothing else in the app is affected.
   */
  async clear(query: { target?: string; olderThanDays?: string; confirm?: string }) {
    if (query.confirm !== 'DELETE') {
      throw new BadRequestException('Add confirm=DELETE to really delete the activity data. This cannot be undone.');
    }
    const target = (query.target || 'all').toLowerCase();
    if (!['all', 'pages', 'logins'].includes(target)) throw new BadRequestException('target must be all, pages or logins.');

    let days: number | null = null;
    if (query.olderThanDays !== undefined && query.olderThanDays !== '' && query.olderThanDays !== '0') {
      days = Number(query.olderThanDays);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new BadRequestException('olderThanDays must be a whole number from 1 to 3650 (or leave it out to delete everything).');
      }
    }

    let pageViews = 0;
    let logins = 0;
    const vacuum: string[] = [];

    if (target === 'all' || target === 'pages') {
      if (days === null) {
        const [{ n }]: any[] = await this.ds.query(`SELECT COUNT(*)::int AS n FROM page_views`);
        pageViews = n;
        // TRUNCATE hands the disk space straight back; fall back to DELETE if the database user may not truncate.
        try {
          await this.ds.query(`TRUNCATE TABLE page_views`);
        } catch {
          await this.ds.query(`DELETE FROM page_views`);
          vacuum.push('page_views');
        }
      } else {
        const [{ n }]: any[] = await this.ds.query(
          `WITH d AS (DELETE FROM page_views WHERE "createdAt" < now() - ($1::int * interval '1 day') RETURNING 1) SELECT COUNT(*)::int AS n FROM d`,
          [days],
        );
        pageViews = n;
        vacuum.push('page_views');
      }
    }

    if (target === 'all' || target === 'logins') {
      const idleMinutes = SESSION_IDLE_MS / 60_000;
      const [{ n }]: any[] = await this.ds.query(
        `WITH d AS (
           DELETE FROM user_sessions
            WHERE ("endedAt" IS NOT NULL OR "lastSeenAt" < now() - ($1::int * interval '1 minute'))
              AND ($2::int IS NULL OR "loginAt" < now() - ($2::int * interval '1 day'))
           RETURNING 1)
         SELECT COUNT(*)::int AS n FROM d`,
        [idleMinutes, days],
      );
      logins = n;
      vacuum.push('user_sessions');
    }

    // A plain DELETE only marks space as reusable; VACUUM FULL gives it back to the disk. Best effort.
    let spaceReturned = true;
    for (const table of vacuum) {
      try {
        await this.ds.query(`VACUUM FULL ${table}`);
      } catch {
        spaceReturned = false;
      }
    }

    return {
      deleted: { pageViews, logins },
      scope: { target, olderThanDays: days },
      spaceReturnedToDisk: spaceReturned,
      storage: await this.storage(),
    };
  }
}
