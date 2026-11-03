import { Repository } from 'typeorm';
import { Job, jobDedupeKey } from '../../entities/job.entity';

/**
 * Insert-or-update a job by its natural identity (source + externalId + applyUrl) and
 * return the stored row. This is the Postgres equivalent of the old
 * `findOneAndUpdate({ source, externalId, applyUrl }, { $set: ... }, { upsert: true, new: true })`:
 *   - the unique key is enforced by the database, so concurrent callers can't create duplicates;
 *   - on update only the fields that are actually provided (not `undefined`) are overwritten;
 *   - on insert, anything not provided takes the column default.
 */
export async function upsertJob(
  repo: Repository<Job>,
  key: { source: string; externalId?: string | null; applyUrl: string },
  fields: Partial<Omit<Job, 'id' | 'createdAt' | 'dedupeKey' | 'toJSON'>>,
): Promise<Job> {
  const dedupeKey = jobDedupeKey(key.source, key.externalId ?? null, key.applyUrl);
  await repo.upsert(
    {
      ...fields,
      source: key.source,
      externalId: key.externalId ?? undefined,
      applyUrl: key.applyUrl,
      dedupeKey,
    } as any,
    ['dedupeKey'],
  );
  return repo.findOneOrFail({ where: { dedupeKey } });
}
