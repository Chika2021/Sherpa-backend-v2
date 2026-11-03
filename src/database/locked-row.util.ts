import { DataSource, EntityTarget } from 'typeorm';

/**
 * Atomic read-modify-write of JSON columns on ONE row.
 *
 * MongoDB let the old code do `$push` / `$pull` / `$slice` / "set only if the
 * key doesn't exist yet" directly on a document. Postgres has no operator for
 * "append to this JSON array and keep the last N", so this helper does the
 * equivalent safely: inside a transaction it locks the row (`FOR UPDATE`),
 * reads the requested columns, lets the caller compute the new values in
 * plain TypeScript, and writes them back. Concurrent calls on the same row
 * queue up behind the lock, so - exactly like `$push` - two simultaneous
 * appends can never overwrite each other.
 *
 *  - `where`   column -> value pairs, ANDed (typically { id, userId }, so ownership is enforced).
 *  - `columns` the JSON columns to read.
 *  - `compute` receives the current column values and returns the columns to
 *              write (values are stored as JSON, except for the columns named in
 *              `plainColumns`, which are written as ordinary scalar values), or
 *              nothing to leave the row alone.
 *
 * Returns whether a row matched, and whether anything was written.
 */
export async function updateLockedRow<Row extends Record<string, any> = Record<string, any>>(
  dataSource: DataSource,
  target: EntityTarget<any>,
  where: Record<string, string>,
  columns: string[],
  compute: (row: Row) => Record<string, unknown> | null | undefined | void,
  plainColumns: string[] = [],
): Promise<{ matched: boolean; changed: boolean; row?: Row }> {
  const meta = dataSource.getMetadata(target);
  const q = (name: string) => dataSource.driver.escape(name);
  const table = q(meta.tableName);

  return dataSource.transaction(async (em) => {
    const whereKeys = Object.keys(where);
    const whereSql = whereKeys.map((key, i) => `${q(key)} = $${i + 1}`).join(' AND ');
    const rows: any[] = await em.query(
      `SELECT ${['id', ...columns].map(q).join(', ')} FROM ${table} WHERE ${whereSql} FOR UPDATE`,
      whereKeys.map((key) => where[key]),
    );
    if (!rows.length) return { matched: false, changed: false };

    const row = rows[0] as Row;
    const patch = compute(row);
    if (!patch || !Object.keys(patch).length) return { matched: true, changed: false, row };

    const keys = Object.keys(patch);
    const sets = keys.map((key, i) => `${q(key)} = $${i + 1}${plainColumns.includes(key) ? '' : '::jsonb'}`);
    if (meta.updateDateColumn) sets.push(`${q(meta.updateDateColumn.databaseName)} = now()`);
    const params: unknown[] = keys.map((key) => {
      const value = (patch as Record<string, unknown>)[key];
      if (plainColumns.includes(key)) return value === undefined ? null : value;
      return value === null || value === undefined ? null : JSON.stringify(value);
    });
    params.push((row as any).id);

    await em.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE "id" = $${params.length}`, params);
    return { matched: true, changed: true, row };
  });
}

/** `$push` with `$slice: -max`: append `items` and keep only the newest `max`. */
export function appendKeepingLast<T>(current: T[] | null | undefined, items: T[], max: number): T[] {
  const next = [...(current ?? []), ...items];
  return max > 0 && next.length > max ? next.slice(next.length - max) : next;
}
