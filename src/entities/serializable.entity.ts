/**
 * Base class for every entity that is sent to the frontend.
 *
 * Why this exists: the old Mongoose schemas produced JSON in a very specific
 * shape - an `id` string, and optional fields that were never set were simply
 * ABSENT from the response (not `null`). Postgres returns `null` for every
 * empty nullable column, so without this the frontend would suddenly start
 * receiving `"company": null` where it used to get no `company` key at all.
 *
 * `toJSON()` (called automatically by `JSON.stringify` / Express) therefore
 * drops `null`/`undefined` values - EXCEPT for the columns an entity lists in
 * `keepNull`, i.e. the ones Mongoose explicitly defaulted to `null`
 * (`feedback`, `submittedAt`, `parsedProfile`, ...), which the frontend has
 * always received as `null`.
 */
export abstract class SerializableEntity {
  /** Property names that are legitimately `null` in API responses. */
  static readonly keepNull: readonly string[] = [];

  toJSON(): Record<string, any> {
    const keep = (this.constructor as typeof SerializableEntity).keepNull ?? [];
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(this)) {
      if (value === undefined) continue;
      if (value === null && !keep.includes(key)) continue;
      out[key] = value;
    }
    return out;
  }
}
