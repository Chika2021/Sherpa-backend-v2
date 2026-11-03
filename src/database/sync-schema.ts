import { AppDataSource } from './data-source';

/**
 * One-off schema creation/update: makes the Postgres tables match the entities.
 *   npm run db:sync
 * Safe to re-run. It only ADDS/ALTERS to match the entities - see
 * POSTGRES_MIGRATION.md for when to switch to real migrations instead.
 */
async function main() {
  await AppDataSource.initialize();
  try {
    await AppDataSource.synchronize();
    const tables: Array<{ tablename: string }> = await AppDataSource.query(
      `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`,
    );
    // eslint-disable-next-line no-console
    console.log(`Schema is in sync. Tables (${tables.length}): ${tables.map((t) => t.tablename).join(', ')}`);
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Schema sync failed:', err?.message ?? err);
  process.exit(1);
});
