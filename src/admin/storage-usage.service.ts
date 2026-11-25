import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, MoreThan, Repository } from 'typeorm';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { StorageSnapshot } from '../entities/storage-snapshot.entity';
import { OTHER_FEATURE, STORAGE_FEATURES, TABLE_TO_FEATURE } from './storage-features';

const CACHE_MS = 60 * 1000;
const MAX_ENTRIES = 300_000;
const MB = 1048576;
const DAY_MS = 86_400_000;
const SNAPSHOT_EVERY_MS = 6 * 60 * 60 * 1000;
const KEEP_SNAPSHOTS_DAYS = 400;
const MAX_POINTS = 150;

interface FolderUsage {
  key: string;
  label: string;
  path: string;
  exists: boolean;
  bytes: number;
  files: number;
  /** true when the folder had more entries than we are willing to count - the size is then a lower bound. */
  partial: boolean;
}

/**
 * "How much space does the whole app use": the database (total and per table) plus the folders the app writes to
 * on the server's disk (uploaded resumes, generated documents, cached audio, the dashboard files).
 * Super admin only. Reports sizes and counts - never file names or contents. Cached for a minute.
 */
@Injectable()
export class StorageUsageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageUsageService.name);
  private cache?: { at: number; deep: boolean; data: any };
  private timers: NodeJS.Timeout[] = [];

  constructor(
    @InjectDataSource() private ds: DataSource,
    @InjectRepository(StorageSnapshot) private snapshots: Repository<StorageSnapshot>,
    private config: ConfigService,
  ) {}

  /** Takes a reading shortly after start-up and then about every 6 hours, so the growth chart fills in by itself. */
  onModuleInit() {
    const first = setTimeout(() => {
      void this.usage({ refresh: true }).catch((e) => this.logger.warn(`Storage reading failed: ${e?.message}`));
      const every = setInterval(() => {
        void this.usage({ refresh: true }).catch((e) => this.logger.warn(`Storage reading failed: ${e?.message}`));
      }, SNAPSHOT_EVERY_MS);
      every.unref();
      this.timers.push(every);
    }, 2 * 60 * 1000);
    first.unref();
    this.timers.push(first);
  }

  onModuleDestroy() {
    this.timers.forEach(clearTimeout);
  }

  /** Size of one folder: walks it without following symlinks. Never throws. */
  private async measure(dir: string): Promise<{ exists: boolean; bytes: number; files: number; partial: boolean }> {
    try {
      await fsp.access(dir);
    } catch {
      return { exists: false, bytes: 0, files: 0, partial: false };
    }
    let bytes = 0;
    let files = 0;
    let seen = 0;
    let partial = false;
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      const sizes = await Promise.all(
        entries.map(async (e) => {
          if (e.isSymbolicLink()) return 0;
          const full = path.join(current, e.name);
          if (e.isDirectory()) {
            stack.push(full);
            return 0;
          }
          if (!e.isFile()) return 0;
          try {
            files += 1;
            return (await fsp.stat(full)).size;
          } catch {
            return 0;
          }
        }),
      );
      for (const s of sizes) bytes += s;
      seen += entries.length;
      if (seen > MAX_ENTRIES) {
        partial = true;
        break;
      }
    }
    return { exists: true, bytes, files, partial };
  }

  /** Every table in the database with its size split into data, indexes and the rest (large-value storage), plus upkeep info. */
  private async tables() {
    const rows: any[] = await this.ds.query(
      `SELECT c.relname AS name,
              pg_total_relation_size(c.oid)::float AS total,
              pg_relation_size(c.oid)::float AS data,
              pg_indexes_size(c.oid)::float AS indexes,
              GREATEST(c.reltuples, 0)::float AS rows,
              COALESCE(st.n_live_tup, 0)::float AS live,
              COALESCE(st.n_dead_tup, 0)::float AS dead,
              COALESCE(st.last_autovacuum, st.last_vacuum) AS vacuumed
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_tables st ON st.relid = c.oid
        WHERE c.relkind = 'r' AND n.nspname = current_schema()
        ORDER BY total DESC`,
    );
    return rows.map((r) => {
      const total = Math.round(r.total);
      const data = Math.round(r.data);
      const indexes = Math.round(r.indexes);
      const approxRows = Math.round(Math.max(r.live, r.rows));
      return {
        name: r.name as string,
        bytes: total,
        dataBytes: data,
        indexBytes: indexes,
        otherBytes: Math.max(0, total - data - indexes),
        approxRows,
        avgRowBytes: approxRows > 0 ? Math.round(total / approxRows) : null,
        deadRows: Math.round(r.dead),
        lastVacuumAt: r.vacuumed ?? null,
      };
    });
  }

  private groupByFeature(tables: Awaited<ReturnType<StorageUsageService['tables']>>, databaseBytes: number) {
    const groups = new Map<string, { key: string; label: string; description: string; tables: typeof tables }>();
    for (const f of STORAGE_FEATURES) groups.set(f.key, { key: f.key, label: f.label, description: f.description, tables: [] });
    groups.set(OTHER_FEATURE.key, { ...OTHER_FEATURE, tables: [] });
    for (const t of tables) groups.get(TABLE_TO_FEATURE[t.name] ?? OTHER_FEATURE.key)!.tables.push(t);

    return [...groups.values()]
      .filter((g) => g.tables.length > 0)
      .map((g) => {
        const bytes = g.tables.reduce((n, t) => n + t.bytes, 0);
        return {
          key: g.key,
          label: g.label,
          description: g.description,
          bytes,
          dataBytes: g.tables.reduce((n, t) => n + t.dataBytes, 0),
          indexBytes: g.tables.reduce((n, t) => n + t.indexBytes, 0),
          approxRows: g.tables.reduce((n, t) => n + t.approxRows, 0),
          percentOfDatabase: databaseBytes ? Math.round((bytes / databaseBytes) * 1000) / 10 : 0,
          tables: g.tables, // already biggest first
        };
      })
      .sort((a, b) => b.bytes - a.bytes);
  }

  // ---------------------------------------------------------------- history

  private async maybeSnapshot(totalBytes: number, databaseBytes: number, filesBytes: number, features: Record<string, number>) {
    try {
      const last = await this.snapshots.findOne({ where: {}, order: { takenAt: 'DESC' } });
      if (last && Date.now() - last.takenAt.getTime() < SNAPSHOT_EVERY_MS) return;
      await this.snapshots.insert({
        totalBytes: String(totalBytes),
        databaseBytes: String(databaseBytes),
        filesBytes: String(filesBytes),
        features,
      });
      await this.snapshots.delete({ takenAt: LessThan(new Date(Date.now() - KEEP_SNAPSHOTS_DAYS * DAY_MS)) });
    } catch (err) {
      // Most likely `npm run db:sync` has not been run yet. The page still works, just without history.
      this.logger.warn(`Could not save a storage reading: ${(err as Error).message}`);
    }
  }

  private async history(current: { totalBytes: number; databaseBytes: number; filesBytes: number; features: Record<string, number> }, limitBytes: number | null) {
    let rows: StorageSnapshot[];
    try {
      rows = await this.snapshots.find({ where: { takenAt: MoreThan(new Date(Date.now() - 365 * DAY_MS)) }, order: { takenAt: 'ASC' }, take: 2000 });
    } catch {
      return null;
    }
    const all = rows.map((r) => ({
      at: r.takenAt,
      totalBytes: Number(r.totalBytes),
      databaseBytes: Number(r.databaseBytes),
      filesBytes: Number(r.filesBytes),
      features: r.features ?? {},
    }));
    if (all.length === 0) return { points: [], growth: null, featureGrowth7d: {}, projection: null };

    const step = Math.max(1, Math.ceil(all.length / MAX_POINTS));
    const points = all.filter((_, i) => i % step === 0 || i === all.length - 1).map(({ at, totalBytes, databaseBytes, filesBytes }) => ({ at, totalBytes, databaseBytes, filesBytes }));

    const now = Date.now();
    const growthOver = (days: number) => {
      const inWindow = all.filter((p) => now - p.at.getTime() <= days * DAY_MS);
      const base = inWindow[0];
      if (!base) return null;
      const spanDays = (now - base.at.getTime()) / DAY_MS;
      if (spanDays < 0.2) return null; // too little time between readings to say anything
      return {
        windowDays: days,
        coveredDays: Math.round(spanDays * 10) / 10,
        totalBytes: current.totalBytes - base.totalBytes,
        databaseBytes: current.databaseBytes - base.databaseBytes,
        filesBytes: current.filesBytes - base.filesBytes,
        perDayTotalBytes: Math.round((current.totalBytes - base.totalBytes) / spanDays),
        perDayDatabaseBytes: Math.round((current.databaseBytes - base.databaseBytes) / spanDays),
        base,
      };
    };
    const g7 = growthOver(7);
    const g30 = growthOver(30);

    const featureGrowth7d: Record<string, number> = {};
    if (g7) for (const [k, v] of Object.entries(current.features)) featureGrowth7d[k] = v - (g7.base.features[k] ?? 0);

    const strip = (g: ReturnType<typeof growthOver>) => (g ? (({ base, ...rest }) => rest)(g) : null);
    const basis = g7 ?? g30;
    const projection =
      limitBytes && basis && basis.perDayDatabaseBytes > 0
        ? { daysUntilFull: Math.max(0, Math.round((limitBytes - current.databaseBytes) / basis.perDayDatabaseBytes)), basedOnDays: basis.coveredDays }
        : null;

    return { points, growth: { last7Days: strip(g7), last30Days: strip(g30) }, featureGrowth7d, projection };
  }

  private async disk() {
    try {
      const s: any = await (fsp as any).statfs(process.cwd());
      const total = Number(s.blocks) * Number(s.bsize);
      const free = Number(s.bavail) * Number(s.bsize);
      return { totalBytes: total, freeBytes: free, usedBytes: Math.max(0, total - free) };
    } catch {
      return null; // older Node, or the platform does not report it
    }
  }

  /** ?deep=1 also measures node_modules and the build output (slower; it is the program itself, not your data). */
  async usage(opts: { deep?: boolean; refresh?: boolean } = {}) {
    const deep = !!opts.deep;
    if (!opts.refresh && this.cache && this.cache.deep === deep && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;

    const root = process.cwd();
    const folders: Array<{ key: string; label: string; dir: string }> = [
      { key: 'uploads', label: 'Uploaded files (resumes)', dir: path.resolve(this.config.get<string>('UPLOAD_DIR') || './uploads') },
      { key: 'generated', label: 'Generated documents', dir: path.resolve(this.config.get<string>('GENERATED_DIR') || './generated') },
      { key: 'audio', label: 'Cached audio', dir: this.config.get<string>('AUDIO_CACHE_DIR')?.trim() || path.join(root, 'audio-cache') },
      { key: 'public', label: 'Dashboard and widget files', dir: path.join(root, 'public') },
    ];
    if (deep) {
      folders.push({ key: 'dist', label: 'Built app (dist)', dir: path.join(root, 'dist') });
      folders.push({ key: 'node_modules', label: 'Dependencies (node_modules)', dir: path.join(root, 'node_modules') });
    }

    const [dbRow, tables, disk, measured] = await Promise.all([
      this.ds.query(`SELECT pg_database_size(current_database())::float AS bytes, current_setting('server_version') AS version`),
      this.tables(),
      this.disk(),
      Promise.all(folders.map((f) => this.measure(f.dir))),
    ]);

    const files: FolderUsage[] = folders.map((f, i) => ({
      key: f.key,
      label: f.label,
      // only the folder's name, never the server's full path
      path: path.basename(f.dir),
      ...measured[i],
    }));
    const databaseBytes = Math.round(dbRow[0]?.bytes ?? 0);
    const filesBytes = files.reduce((n, f) => n + f.bytes, 0);
    const tablesBytes = tables.reduce((n, t) => n + t.bytes, 0);
    const features = this.groupByFeature(tables, databaseBytes);
    const featureBytes = Object.fromEntries(features.map((f) => [f.key, f.bytes]));

    const limitMb = Number(this.config.get<string>('DB_STORAGE_LIMIT_MB'));
    const databaseLimitBytes = Number.isFinite(limitMb) && limitMb > 0 ? Math.round(limitMb * MB) : null;
    const totalBytes = databaseBytes + filesBytes;

    // Growth needs readings over time; save one now if the last is old, then read the history back.
    await this.maybeSnapshot(totalBytes, databaseBytes, filesBytes, featureBytes);
    const history = await this.history({ totalBytes, databaseBytes, filesBytes, features: featureBytes }, databaseLimitBytes);
    const featureGrowth: Record<string, number> = history?.featureGrowth7d ?? {};

    const data = {
      measuredAt: new Date().toISOString(),
      deep,
      totalBytes,
      database: {
        bytes: databaseBytes,
        version: dbRow[0]?.version ?? null,
        tablesBytes,
        /** What the database holds besides your tables: system catalogs, other schemas, internal bookkeeping. */
        systemBytes: Math.max(0, databaseBytes - tablesBytes),
        tableCount: tables.length,
        limitBytes: databaseLimitBytes,
        percentOfLimit: databaseLimitBytes ? Math.round((databaseBytes / databaseLimitBytes) * 1000) / 10 : null,
        features: features.map((f) => ({ ...f, growth7dBytes: f.key in featureGrowth ? featureGrowth[f.key] : null })),
      },
      files: { bytes: filesBytes, folders: files },
      disk,
      history,
    };
    this.cache = { at: Date.now(), deep, data };
    return data;
  }
}
