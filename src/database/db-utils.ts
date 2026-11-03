import { NotFoundException } from '@nestjs/common';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Route params / DTO fields holding an id are plain strings that may not be
 * valid ids (a stale link, a typo, something copy-pasted wrong). Postgres
 * throws "invalid input syntax for type uuid" for those instead of just
 * finding nothing, which would surface as a confusing 500 - this turns it
 * into the same 404 the app has always returned.
 *
 * It also guards something TypeORM-specific: `findOneBy({ id: undefined })`
 * silently matches ANY row (an undefined condition is dropped), so every
 * lookup that takes an id from outside must go through this first.
 */
export function assertValidId(id: string | undefined | null, label = 'Record'): asserts id is string {
  if (!isUuid(id)) {
    throw new NotFoundException(`${label} not found`);
  }
}

/** Escapes `%`, `_` and `\` so a user-supplied string can be used inside a LIKE/ILIKE pattern literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

/**
 * `{ id, userId }` filter for "this row, but only if it belongs to this user".
 * Validates BOTH values first: TypeORM silently drops an `undefined` condition,
 * which would otherwise turn an ownership check into "any row".
 */
export function ownedBy(id: string | undefined | null, userId: string | undefined | null, label: string) {
  assertValidId(id, label);
  assertValidId(userId, 'User');
  return { id, userId };
}
