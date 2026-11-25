import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { PageView } from '../entities/page-view.entity';
import { assertValidId, escapeLike } from '../database/db-utils';
import { ActivityService } from './activity.service';

const UNTRACKED_ROLES = new Set(['SUPER_ADMIN']);
/** Same user opening the same path again within this window (double render, quick refresh) counts once. */
const DEDUPE_MS = 2000;
const MAX_PATH = 300;
const MAX_RANGE_DAYS = 366;

const UUID_SEG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUM_SEG = /^\d+$/;
const HEX_SEG = /^[0-9a-f]{16,}$/i;

/** "/dashboard/jobs/6f1c...?x=1#top" -> { path: "/dashboard/jobs/6f1c...", pattern: "/dashboard/jobs/:id" } */
export function normalizePath(raw: string): { path: string; pattern: string } {
  let p = String(raw ?? '').trim();
  p = p.split('#')[0].split('?')[0];
  if (!p.startsWith('/')) throw new BadRequestException('path must start with "/".');
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (p.length > MAX_PATH) throw new BadRequestException(`path is longer than ${MAX_PATH} characters.`);
  const pattern = p
    .split('/')
    .map((seg) => (UUID_SEG.test(seg) || NUM_SEG.test(seg) || HEX_SEG.test(seg) ? ':id' : seg))
    .join('/');
  return { path: p, pattern };
}

/** Records page opens, and answers the super admin's questions about them. */
@Injectable()
export class PageAnalyticsService {
  private readonly logger = new Logger(PageAnalyticsService.name);
  private readonly recent = new Map<string, number>();

  constructor(
    @InjectRepository(PageView) private views: Repository<PageView>,
    @InjectDataSource() private ds: DataSource,
    private activity: ActivityService,
  ) {}

  // ---------------------------------------------------------------- recording

  async record(user: { id: string; role?: string | null }, body: { path: string; title?: string }) {
    if (UNTRACKED_ROLES.has(user.role ?? 'USER')) return { ok: true };
    const { path, pattern } = normalizePath(body.path);

    const key = `${user.id}|${path}`;
    const now = Date.now();
    const last = this.recent.get(key);
    if (last && now - last < DEDUPE_MS) return { ok: true };
    if (this.recent.size > 10_000) {
      for (const [k, t] of this.recent) if (now - t > DEDUPE_MS) this.recent.delete(k);
    }
    this.recent.set(key, now);

    try {
      await this.views.insert({ userId: user.id, path, pattern, title: body.title?.slice(0, 200) || null });
    } catch (err) {
      // Tracking must never break the app.
      this.logger.warn(`Could not record page view for ${user.id}: ${(err as Error).message}`);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- reports

  private range(q: { from?: string; to?: string; tz?: string }) {
    const tz = this.activity.resolveTz(q.tz);
    const to = this.activity.parseDate(q.to, 'to') ?? this.activity.today(tz);
    const from = this.activity.parseDate(q.from, 'from') ?? this.activity.addDays(to, -6);
    if (from > to) throw new BadRequestException('"from" must not be after "to".');
    if (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > MAX_RANGE_DAYS * 86_400_000) {
      throw new BadRequestException(`Pick a range of at most ${MAX_RANGE_DAYS} days.`);
    }
    return { tz, from, to };
  }

  /**
   * Which pages get the most attention. One row per page pattern, most-viewed first:
   * total views, how many different users opened it, views per user, share of all views, last opened.
   * Defaults to the last 7 days. ?role= limits it to one kind of account; ?limit= (default 25, max 200).
   */
  async topPages(q: { from?: string; to?: string; tz?: string; role?: string; limit?: string }) {
    const { tz, from, to } = this.range(q);
    const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200);
    const params: any[] = [tz, from, to];
    let extra = '';
    if (q.role?.trim()) {
      params.push(q.role.trim().toUpperCase());
      extra = ` AND u.role = $${params.length}`;
    }
    const where = `v."createdAt" >= ($2::date)::timestamp AT TIME ZONE $1::text
               AND v."createdAt" <  (($3::date + 1))::timestamp AT TIME ZONE $1::text${extra}`;

    const [rows, totals]: [any[], any[]] = await Promise.all([
      this.ds.query(
        `SELECT v.pattern AS page,
                COUNT(*)::int AS views,
                COUNT(DISTINCT v."userId")::int AS "uniqueUsers",
                MAX(v."createdAt") AS "lastOpenedAt"
           FROM page_views v JOIN users u ON u.id = v."userId"
          WHERE ${where}
          GROUP BY v.pattern
          ORDER BY views DESC, "uniqueUsers" DESC
          LIMIT ${limit}`,
        params,
      ),
      this.ds.query(
        `SELECT COUNT(*)::int AS views, COUNT(DISTINCT v."userId")::int AS users, COUNT(DISTINCT v.pattern)::int AS pages
           FROM page_views v JOIN users u ON u.id = v."userId" WHERE ${where}`,
        params,
      ),
    ]);

    const totalViews = totals[0]?.views ?? 0;
    return {
      timezone: tz,
      from,
      to,
      totals: { views: totalViews, uniqueUsers: totals[0]?.users ?? 0, distinctPages: totals[0]?.pages ?? 0 },
      mostVisited: rows[0]?.page ?? null,
      pages: rows.map((r, i) => ({
        rank: i + 1,
        page: r.page,
        views: r.views,
        uniqueUsers: r.uniqueUsers,
        viewsPerUser: Math.round((r.views / Math.max(r.uniqueUsers, 1)) * 10) / 10,
        sharePercent: totalViews ? Math.round((r.views / totalViews) * 1000) / 10 : 0,
        lastOpenedAt: r.lastOpenedAt,
      })),
    };
  }

  /** Views per day for ONE page pattern (e.g. /dashboard/jobs/:id), zeros included, for a trend chart. */
  async pageTrend(q: { page?: string; from?: string; to?: string; tz?: string }) {
    if (!q.page?.trim()) throw new BadRequestException('?page= is required, e.g. /dashboard/jobs/:id');
    const { tz, from, to } = this.range(q);
    const rows: Array<{ day: string; views: number; users: number }> = await this.ds.query(
      `SELECT to_char(v."createdAt" AT TIME ZONE $1::text, 'YYYY-MM-DD') AS day,
              COUNT(*)::int AS views, COUNT(DISTINCT v."userId")::int AS users
         FROM page_views v
        WHERE v.pattern = $4
          AND v."createdAt" >= ($2::date)::timestamp AT TIME ZONE $1::text
          AND v."createdAt" <  (($3::date + 1))::timestamp AT TIME ZONE $1::text
        GROUP BY 1`,
      [tz, from, to, q.page.trim()],
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const days: Array<{ date: string; views: number; uniqueUsers: number }> = [];
    for (let d = to; d >= from; d = this.activity.addDays(d, -1)) {
      days.push({ date: d, views: byDay.get(d)?.views ?? 0, uniqueUsers: byDay.get(d)?.users ?? 0 });
    }
    return { timezone: tz, page: q.page.trim(), from, to, days };
  }

  /**
   * EVERY page one user opened, newest first, with the time. Defaults to the last 7 days.
   * ?page= number (default 1), ?pageSize= (default 100, max 500), ?search= filters by path.
   */
  async forUser(userId: string, q: { from?: string; to?: string; tz?: string; page?: string; pageSize?: string; search?: string }) {
    assertValidId(userId, 'User');
    const { tz, from, to } = this.range(q);
    const pageSize = Math.min(Math.max(Number(q.pageSize) || 100, 1), 500);
    const page = Math.max(Number(q.page) || 1, 1);
    const params: any[] = [userId, tz, from, to];
    let extra = '';
    if (q.search?.trim()) {
      params.push(`%${escapeLike(q.search.trim())}%`);
      extra = ` AND v.path ILIKE $${params.length}`;
    }
    const where = `v."userId" = $1
        AND v."createdAt" >= ($3::date)::timestamp AT TIME ZONE $2::text
        AND v."createdAt" <  (($4::date + 1))::timestamp AT TIME ZONE $2::text${extra}`;

    const [rows, count, summary]: [any[], any[], any[]] = await Promise.all([
      this.ds.query(
        `SELECT v.id, v.path, v.pattern, v.title, v."createdAt",
                to_char(v."createdAt" AT TIME ZONE $2::text, 'YYYY-MM-DD') AS date
           FROM page_views v WHERE ${where}
          ORDER BY v."createdAt" DESC
          LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        params,
      ),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM page_views v WHERE ${where}`, params),
      this.ds.query(
        `SELECT v.pattern AS page, COUNT(*)::int AS views FROM page_views v WHERE ${where}
          GROUP BY v.pattern ORDER BY views DESC LIMIT 10`,
        params,
      ),
    ]);

    return {
      timezone: tz,
      from,
      to,
      total: count[0]?.n ?? 0,
      page,
      pageSize,
      favouritePages: summary,
      views: rows.map((r) => ({
        id: r.id,
        path: r.path,
        page: r.pattern,
        title: r.title ?? undefined,
        openedAt: r.createdAt,
        date: r.date,
        time: this.activity.clock(r.createdAt, tz),
      })),
    };
  }

  /** Pages opened by everyone on one day, grouped by user: handy for "what did people do today". ?date=&tz=&search=&role= */
  async day(q: { date?: string; tz?: string; search?: string; role?: string }) {
    const tz = this.activity.resolveTz(q.tz);
    const date = this.activity.parseDate(q.date, 'date') ?? this.activity.today(tz);
    const params: any[] = [date, tz];
    let extra = '';
    if (q.search?.trim()) {
      params.push(`%${escapeLike(q.search.trim())}%`);
      extra += ` AND (u.email ILIKE $${params.length} OR concat_ws(' ', u."firstName", u."lastName") ILIKE $${params.length})`;
    }
    if (q.role?.trim()) {
      params.push(q.role.trim().toUpperCase());
      extra += ` AND u.role = $${params.length}`;
    }
    const rows: any[] = await this.ds.query(
      `SELECT v."userId", u.email, u."firstName", u."lastName", u.role,
              COUNT(*)::int AS views, COUNT(DISTINCT v.pattern)::int AS "distinctPages",
              MIN(v."createdAt") AS "firstAt", MAX(v."createdAt") AS "lastAt",
              (array_agg(v.path ORDER BY v."createdAt" DESC))[1:50] AS "latestPaths"
         FROM page_views v JOIN users u ON u.id = v."userId"
        WHERE v."createdAt" >= ($1::date)::timestamp AT TIME ZONE $2::text
          AND v."createdAt" <  (($1::date + 1))::timestamp AT TIME ZONE $2::text
          ${extra}
        GROUP BY v."userId", u.email, u."firstName", u."lastName", u.role
        ORDER BY views DESC
        LIMIT 500`,
      params,
    );
    return {
      timezone: tz,
      date,
      users: rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: [r.firstName, r.lastName].filter(Boolean).join(' ') || r.email,
        role: r.role,
        views: r.views,
        distinctPages: r.distinctPages,
        firstAt: r.firstAt,
        lastAt: r.lastAt,
        latestPaths: r.latestPaths,
      })),
    };
  }
}
