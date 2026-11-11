import 'reflect-metadata';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModulesContainer } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { GeminiService } from '../ai/gemini.service';
import { MailService } from '../mail/mail.service';
import { AdminService } from './admin.service';
import { scanCodebase, CodebaseReport } from './codebase-scanner';
import { CATEGORY_ORDER, describePackage } from './tech-catalog';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD', 'SEARCH'];
const STATIC_TTL_MS = 10 * 60 * 1000;
const MB = 1048576;

/**
 * Everything the super admin's "App info" screen shows: the tools the app is built with, how complex it
 * is, its architecture and API surface, the database, and which external services are wired up.
 * Reports names and booleans only - never a secret value, connection string or credential.
 * Slow, rarely-changing parts (source scan, route list, package.json) are cached for 10 minutes.
 */
@Injectable()
export class AppInfoService {
  private cache?: { at: number; data: ReturnType<AppInfoService['buildStatic']> };

  constructor(
    private config: ConfigService,
    private admin: AdminService,
    private gemini: GeminiService,
    private mail: MailService,
    private modules: ModulesContainer,
    @InjectDataSource() private ds: DataSource,
  ) {}

  async collect() {
    const base = this.admin.systemInfo();
    const stat = this.getStatic();
    const database = await this.databaseInfo();

    const has = (k: string) => Boolean(this.config.get<string>(k));
    const set = (names: string[]) => names.map((name) => ({ name, set: has(name) }));
    const services = this.services(stat.codebase?.jobProviders ?? [], database);

    return {
      generatedAt: new Date().toISOString(),
      app: {
        ...base.app,
        version: stat.pkg?.version ?? null,
        description: stat.pkg?.description ?? null,
        apiPrefix: 'api/v1',
        engines: stat.pkg?.engines ?? null,
      },
      runtime: {
        ...base.runtime,
        pid: process.pid,
        os: `${os.type()} ${os.release()}`,
        arch: os.arch(),
        cpus: os.cpus().length,
        loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
        totalMemoryMb: Math.round(os.totalmem() / MB),
        freeMemoryMb: Math.round(os.freemem() / MB),
      },
      complexity: stat.complexity,
      stack: stat.stack,
      architecture: stat.architecture,
      database,
      services,
      configuration: stat.codebase ? set(stat.codebase.envVars) : [],
      pricing: base.pricing,
      ai: base.ai,
    };
  }

  // ------------------------------------------------------------------ cached, rarely-changing parts

  private getStatic() {
    if (this.cache && Date.now() - this.cache.at < STATIC_TTL_MS) return this.cache.data;
    const data = this.buildStatic();
    this.cache = { at: Date.now(), data };
    return data;
  }

  private buildStatic() {
    const root = process.cwd();
    const pkg = this.readPackageJson(root);
    const codebase = this.safe(() => scanCodebase(root));
    const architecture = this.architecture();
    const stack = this.stack(pkg);
    const complexity = this.complexity(codebase, architecture, stack);
    return { pkg, codebase, architecture, stack, complexity };
  }

  private safe<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch {
      return null;
    }
  }

  private readPackageJson(root: string): any | null {
    const file = join(root, 'package.json');
    if (!existsSync(file)) return null;
    return this.safe(() => JSON.parse(readFileSync(file, 'utf8')));
  }

  private stack(pkg: any | null) {
    if (!pkg) return { available: false, groups: [], dependencies: 0, devDependencies: 0, scripts: [] as string[] };
    const rows: { name: string; version: string; dev: boolean; category: string; purpose: string }[] = [];
    for (const [dev, deps] of [[false, pkg.dependencies ?? {}], [true, pkg.devDependencies ?? {}]] as const) {
      for (const [name, version] of Object.entries<string>(deps)) rows.push({ name, version, dev, ...describePackage(name) });
    }
    const groups = CATEGORY_ORDER.map((category) => ({
      category,
      items: rows.filter((r) => r.category === category).sort((a, b) => a.name.localeCompare(b.name)),
    })).filter((g) => g.items.length);
    return {
      available: true,
      groups,
      dependencies: Object.keys(pkg.dependencies ?? {}).length,
      devDependencies: Object.keys(pkg.devDependencies ?? {}).length,
      scripts: Object.keys(pkg.scripts ?? {}),
    };
  }

  /** Walks every controller Nest registered and reads the route + access metadata off it. */
  private architecture() {
    const endpoints: { method: string; path: string; access: string; roles: string[] | null }[] = [];
    let modules = 0;
    let controllers = 0;
    let providers = 0;

    for (const mod of this.modules.values()) {
      modules++;
      providers += mod.providers.size;
      for (const wrapper of mod.controllers.values()) {
        const ctrl: any = wrapper.metatype;
        if (!ctrl?.prototype) continue;
        controllers++;
        const base: string = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
        const classRoles: string[] | undefined = Reflect.getMetadata(ROLES_KEY, ctrl);
        const classGuards: any[] = Reflect.getMetadata(GUARDS_METADATA, ctrl) ?? [];

        for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
          if (name === 'constructor') continue;
          const handler = ctrl.prototype[name];
          if (typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler);
          if (method === undefined) continue;

          const sub: string = Reflect.getMetadata(PATH_METADATA, handler) ?? '/';
          const roles: string[] | undefined = Reflect.getMetadata(ROLES_KEY, handler) ?? classRoles;
          const guards = [...classGuards, ...(Reflect.getMetadata(GUARDS_METADATA, handler) ?? [])].map((g) => g?.name ?? '');
          const authenticated = guards.includes('JwtAuthGuard');
          const path = ('/api/v1/' + [base, sub].join('/')).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

          endpoints.push({
            method: HTTP_METHODS[method] ?? String(method),
            path,
            roles: roles?.length ? roles : null,
            access: roles?.length ? roles.join(', ') : authenticated ? 'Any signed-in user' : 'Public',
          });
        }
      }
    }
    endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

    const byMethod: Record<string, number> = {};
    for (const e of endpoints) byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
    const byRole: Record<string, number> = {};
    for (const e of endpoints) for (const r of e.roles ?? []) byRole[r] = (byRole[r] ?? 0) + 1;

    const entities = this.ds.entityMetadatas.map((m) => ({
      name: m.tableName,
      columns: m.columns.length,
      relations: m.relations.length,
      indexes: m.indices.length,
    }));

    return {
      modules,
      controllers,
      providers,
      endpoints: {
        total: endpoints.length,
        public: endpoints.filter((e) => e.access === 'Public').length,
        signedIn: endpoints.filter((e) => e.access === 'Any signed-in user').length,
        roleRestricted: endpoints.filter((e) => e.roles).length,
        byMethod,
        byRole,
      },
      entities,
      endpointList: endpoints,
    };
  }

  /**
   * One 0-100 index so "how complex is this app" has a single answer, with the factors shown so it is not
   * a black box. Each factor is capped, so a huge app tops out at 100 rather than overflowing.
   */
  private complexity(codebase: CodebaseReport | null, arch: ReturnType<AppInfoService['architecture']>, stack: ReturnType<AppInfoService['stack']>) {
    const integrations = this.integrationCount(codebase);
    const factor = (name: string, value: number, cap: number, max: number, unit = '') => ({
      name, value, unit, max, points: Math.round(Math.min(value / cap, 1) * max * 10) / 10,
    });
    const factors = [
      factor('Lines of code', codebase?.codeLines ?? 0, 30_000, 25),
      factor('Decision points (cyclomatic total)', codebase?.complexity ?? 0, 5_000, 20),
      factor('External integrations', integrations, 12, 20),
      factor('API endpoints', arch.endpoints.total, 300, 15),
      factor('Database tables', arch.entities.length, 40, 10),
      factor('Avg complexity per function', codebase?.perFunction ?? 0, 10, 10),
    ];
    const index = Math.round(factors.reduce((a, f) => a + f.points, 0));
    const level = index < 25 ? 'Simple' : index < 50 ? 'Moderate' : index < 75 ? 'Complex' : 'Very complex';
    return {
      index,
      level,
      factors,
      codebase,
      note: codebase
        ? codebase.source === 'dist'
          ? 'Source files were not found next to the server, so the compiled JavaScript was measured instead.'
          : 'Measured from the TypeScript source on the server (comments and string literals excluded).'
        : 'Source code is not present on this server, so code metrics are unavailable. Architecture and database figures are still live.',
      dependencyCount: stack.dependencies + stack.devDependencies,
    };
  }

  private integrationCount(codebase: CodebaseReport | null) {
    const core = 6; // Postgres, Gemini, Cerebras, Paystack, email, Redis
    return core + 1 /* Apify */ + (codebase?.jobProviders.length ?? 0);
  }

  // ------------------------------------------------------------------ live parts

  private async databaseInfo() {
    const url = this.config.get<string>('DATABASE_URL') ?? '';
    let host: string | null = null;
    let port: string | null = null;
    try {
      const u = new URL(url);
      host = u.hostname;
      port = u.port || '5432';
    } catch { /* not a URL - leave blank */ }

    const meta = this.ds.entityMetadatas.map((m) => ({
      name: m.tableName, columns: m.columns.length, relations: m.relations.length, indexes: m.indices.length,
    }));

    let version: string | null = null;
    let sizeMb: number | null = null;
    let tableStats: { name: string; rows: number; sizeMb: number }[] = [];
    try {
      const [v] = await this.ds.query('SELECT version() AS v, pg_database_size(current_database()) AS bytes');
      version = String(v.v).split(',')[0];
      sizeMb = Math.round((Number(v.bytes) / MB) * 10) / 10;
      const rows = await this.ds.query(
        'SELECT relname AS name, n_live_tup::bigint AS rows, pg_total_relation_size(relid)::bigint AS bytes FROM pg_stat_user_tables',
      );
      tableStats = rows.map((r: any) => ({ name: r.name, rows: Number(r.rows), sizeMb: Math.round((Number(r.bytes) / MB) * 100) / 100 }));
    } catch { /* stats are a nicety; the screen still works without them */ }

    const stats = new Map(tableStats.map((t) => [t.name, t]));
    const tables = meta
      .map((m) => ({ ...m, rows: stats.get(m.name)?.rows ?? null, sizeMb: stats.get(m.name)?.sizeMb ?? null }))
      .sort((a, b) => (b.sizeMb ?? 0) - (a.sizeMb ?? 0) || a.name.localeCompare(b.name));

    return {
      engine: 'PostgreSQL',
      version,
      provider: host?.includes('supabase') ? 'Supabase' : host && ['localhost', '127.0.0.1'].includes(host) ? 'Local' : host ? 'Hosted' : null,
      host,
      port,
      ssl: this.config.get<string>('DATABASE_SSL') ?? 'auto',
      synchronize: Boolean((this.ds.options as any).synchronize),
      poolMax: Number(this.config.get<string>('DB_POOL_MAX') ?? 10),
      sizeMb,
      tableCount: tables.length,
      totalRows: tables.reduce((a, t) => a + (t.rows ?? 0), 0),
      tables,
    };
  }

  private services(jobProviders: string[], db: { provider: string | null; host: string | null; version: string | null }) {
    const has = (k: string) => Boolean(this.config.get<string>(k));
    let ai: any = null;
    try { ai = this.gemini.getAiStatus(); } catch { /* ignore */ }
    const paystackKey = this.config.get<string>('PAYSTACK_SECRET_KEY') ?? '';
    const mail = this.mail.providerName();
    type S = { name: string; kind: string; status: 'ok' | 'missing' | 'info'; detail: string };
    const list: S[] = [
      { name: 'PostgreSQL', kind: 'Database', status: db.version ? 'ok' : 'missing', detail: [db.provider, db.version, db.host].filter(Boolean).join(' · ') || 'No connection details' },
      { name: 'Google Gemini', kind: 'AI (primary)', status: ai?.primary?.apiKeysConfigured ? 'ok' : 'missing', detail: ai?.primary ? `${ai.primary.model} · ${ai.primary.apiKeysConfigured} API key(s) with automatic failover` : 'Not configured' },
      { name: 'Cerebras', kind: 'AI (fallback)', status: has('CEREBRAS_API_KEY') ? 'ok' : 'missing', detail: has('CEREBRAS_API_KEY') ? 'API key set' : 'Not configured' },
      { name: 'Paystack', kind: 'Payments', status: paystackKey ? 'ok' : 'missing', detail: paystackKey ? `${paystackKey.startsWith('sk_live') ? 'LIVE' : 'TEST'} mode` : 'Not configured' },
      { name: 'Email', kind: 'Transactional email', status: mail === 'none' ? 'missing' : 'ok', detail: mail === 'none' ? 'No provider configured' : mail },
      { name: 'Redis', kind: 'Queues (Bull)', status: 'info', detail: `${this.config.get<string>('REDIS_HOST') || '127.0.0.1'}:${this.config.get<string>('REDIS_PORT') || '6379'}` },
      { name: 'Apify', kind: 'Job scraping', status: has('APIFY_TOKEN') || has('APIFY_API_TOKEN') ? 'ok' : 'missing', detail: has('APIFY_TOKEN') || has('APIFY_API_TOKEN') ? 'Token set' : 'Not configured' },
    ];
    for (const p of jobProviders) list.push({ name: p, kind: 'Job board source', status: 'info', detail: 'Provider module present' });
    return list;
  }
}
