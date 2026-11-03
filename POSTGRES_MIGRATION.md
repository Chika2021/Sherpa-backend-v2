# MongoDB (Mongoose) → Supabase Postgres (TypeORM) migration notes

MongoDB and Mongoose have been removed. The app now talks to **Supabase Postgres**
through **TypeORM** (`@nestjs/typeorm` + `pg`). Controllers, DTOs, routes, request bodies
and response shapes are unchanged - only the data-access layer underneath was replaced.

## Setup

```bash
rm -rf node_modules package-lock.json   # the old lockfile still lists mongoose
npm install

# .env  (see "Environment" below)
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres

npm run db:sync        # creates the tables from the entities (safe to re-run)
npm run start:dev
```

### Environment

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Supabase connection string (URI). Same variable name as before, new value. |
| `DATABASE_SSL` | `true`/`false`. Default: on for any non-local host (Supabase needs SSL), off for localhost. |
| `DB_SYNCHRONIZE` | `true` lets TypeORM create/alter tables at startup. Default: on outside production, **off when `NODE_ENV=production`** (run `npm run db:sync` once instead). |
| `DB_POOL_MAX` | Pool size (default 10). |
| `DB_LOGGING` | `true` logs every SQL query. |

Which Supabase connection string? The **Session pooler** (port 5432) or the **direct** connection
work for everything, including `db:sync`. The Transaction pooler (port 6543) also works for the
running app, but use 5432 for `db:sync`/migrations.

## What changed

- `src/schemas/*` (Mongoose) → `src/entities/*` (TypeORM). One table per old collection, same
  field names (camelCase columns), plus `src/entities/entities.module.ts`, which every feature
  module imports (the replacement for `SchemasModule`).
- `src/database/` → `database.module.ts` (connection), `database.config.ts`, `data-source.ts` + `sync-schema.ts`
  (CLI), `db-utils.ts` (id validation), `locked-row.util.ts` (atomic JSON-array updates).
- **IDs** are now UUID strings instead of Mongo ObjectIds. They are still serialised as `id` (string).
- **JSON shape is preserved.** `SerializableEntity.toJSON()` drops `null` for fields Mongo used to
  omit, and keeps `null` only for the fields Mongoose explicitly defaulted to `null`
  (`feedback`, `submittedAt`, `parsedProfile`, ...). Relations (`job`, `user`) appear only when loaded,
  exactly like `.populate()`.
- **Mongo-specific features re-implemented:**
  - `$push` / `$pull` / `$slice` / "set if key missing" → `updateLockedRow()` (transaction + `SELECT … FOR UPDATE`),
    so concurrent appends still can't overwrite each other.
  - Upserts → `INSERT … ON CONFLICT` (`repo.upsert`, `orIgnore`) on real unique indexes.
  - Token balance changes → one transaction that locks the user row, checks funds, updates the balance and
    writes the ledger row (no negative balances under concurrency). **No replica set needed any more.**
  - **Audio is no longer stored in the database at all** (see below).
  - `Job` uniqueness on `(source, externalId, applyUrl)` is enforced through a SHA-256 `dedupeKey` column
    (Postgres btree indexes can't hold very long URLs).
  - Emails are normalised (trim + lower-case) in code, as the Mongoose setter used to do.
- Foreign keys now exist (e.g. deleting a user cascades). Deleting a resume sets `applications.resumeId` to `NULL`.

## Two security fixes that came along (behaviour you might notice)

1. `PATCH /users/me` used to pass the raw request body to the database, so a client could set its own
   `tokens` or `passwordHash`. It now writes only `firstName, lastName, phone, location, linkedinUrl, portfolioUrl`.
2. `GET /applications/:id` (and the assisted-apply responses built on it) used to include the populated
   `user` **with its `passwordHash`**. Those credential fields are now stripped.

## Things to know

- **Existing MongoDB data is not migrated** - you start with an empty Postgres database. Users must register
  again; old JWTs (which carry Mongo ids) are treated as signed-out. A one-off Mongo → Postgres copy script can be written if you need it.
- `package-lock.json` is not included - run `npm install` to generate it.
- For a production database, once the schema is stable, switch from `db:sync` to migrations:
  `npm run migration:generate -- src/database/migrations/Init` then `npm run migration:run`.

## Audio: streamed, not stored in the database

Generated speech is never written to Postgres. It is streamed to the listener as Gemini produces it.
To avoid paying Gemini for the same text twice, chunks are kept in a **size-capped folder on disk**
(least-recently-used files are deleted first) - not in the database, and not in the public `/files` folder.

| Variable | Default | Meaning |
|---|---|---|
| `AUDIO_CACHE` | `disk` | `none` = store nothing anywhere; every play is streamed live and discarded. |
| `AUDIO_CACHE_DIR` | `./audio-cache` | Where the on-disk cache lives. |
| `AUDIO_CACHE_MAX_MB` | `300` | Cap on the cache; oldest-used chunks are removed beyond it. |

`AUDIO_CACHE=none` uses no disk at all, but every replay costs Gemini TTS calls, and the free tier allows very few.
On hosts with an ephemeral disk the cache just starts empty after a deploy.

**To free the space already used:** run `supabase-free-audio-space.sql` in the Supabase SQL editor
(it drops the unused `audio_chunks` / `audio_cache` tables).
