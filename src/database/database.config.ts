import { DataSourceOptions } from 'typeorm';
import { ALL_ENTITIES } from '../entities';

const truthy = (v?: string) => ['true', '1', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());
const falsy = (v?: string) => ['false', '0', 'no', 'off'].includes((v ?? '').trim().toLowerCase());

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === 'host.docker.internal';
  } catch {
    return false;
  }
}

/**
 * The one place the Postgres connection is described. Used by the Nest app
 * (DatabaseModule) AND by the TypeORM CLI (data-source.ts), so they can never
 * disagree.
 *
 * Environment variables:
 *   DATABASE_URL     Supabase -> Project Settings -> Database -> Connection string (URI).
 *                    e.g. postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
 *   DATABASE_SSL     "true"/"false". Default: ON for any non-local host (Supabase requires SSL),
 *                    OFF for localhost.
 *   DB_SYNCHRONIZE   "true" makes TypeORM create/alter tables from the entities on startup.
 *                    Default: true outside production, false when NODE_ENV=production
 *                    (run `npm run db:sync` once instead - see POSTGRES_MIGRATION.md).
 *   DB_POOL_MAX      max connections in this app's pool (default 10).
 *   DB_CONNECTION_TIMEOUT_MS  how long to wait for a database connection, in ms (default 30000).
 *   DB_LOGGING       "true" logs every SQL query (debugging only).
 */
export function buildDataSourceOptions(env: (key: string) => string | undefined): DataSourceOptions {
  const url = env('DATABASE_URL')?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Put your Supabase Postgres connection string in .env (see POSTGRES_MIGRATION.md).',
    );
  }
  if (/^mongodb(\+srv)?:\/\//i.test(url)) {
    throw new Error(
      'DATABASE_URL still points at MongoDB. Replace it with your Supabase Postgres connection string (postgresql://...).',
    );
  }

  const sslSetting = env('DATABASE_SSL');
  const useSsl = truthy(sslSetting) || (!falsy(sslSetting) && !isLocalUrl(url));

  const syncSetting = env('DB_SYNCHRONIZE');
  const synchronize = syncSetting !== undefined && syncSetting.trim() !== ''
    ? truthy(syncSetting)
    : env('NODE_ENV') !== 'production';

  return {
    type: 'postgres',
    url,
    entities: ALL_ENTITIES,
    synchronize,
    // gen_random_uuid() is built into Postgres 13+ (every Supabase project) - no uuid-ossp needed.
    uuidExtension: 'pgcrypto',
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    logging: truthy(env('DB_LOGGING')) ? ['error', 'warn', 'query'] : ['error'],
    extra: {
      max: Number(env('DB_POOL_MAX')) || 10,
      // Supabase's pooler closes idle connections; give ours up first and keep live ones alive, so the
      // app doesn't pick a dead connection ("read ECONNRESET").
      idleTimeoutMillis: 10_000,
      // How long to wait for a new connection (TLS included). Slow or flaky networks need more than 15s.
      connectionTimeoutMillis: Number(env('DB_CONNECTION_TIMEOUT_MS')) || 30_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    },
  };
}
