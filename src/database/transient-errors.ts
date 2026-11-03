/**
 * True for database errors that mean "the connection dropped" (a pooled connection that the server or the
 * Supabase pooler closed), where simply trying the same operation again on a fresh connection normally works.
 */
export function isTransientConnectionError(error: unknown): boolean {
  const err = error as {
    code?: unknown;
    message?: unknown;
    driverError?: { code?: unknown; message?: unknown };
  } | null;
  const code = [err?.code, err?.driverError?.code].find((value) => typeof value === 'string');
  const message = [err?.message, err?.driverError?.message]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');

  return (
    (typeof code === 'string' && /^(?:ECONNRESET|ETIMEDOUT|EPIPE|57P01|57P02|57P03|08000|08003|08006)$/.test(code)) ||
    /connection terminated|terminating connection|socket hang up|connection (?:reset|closed)|ECONNRESET/i.test(message)
  );
}
