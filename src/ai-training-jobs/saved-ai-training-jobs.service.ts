import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { SavedAiTrainingJob } from '../entities/saved-ai-training-job.entity';
import { assertValidId } from '../database/db-utils';
import { AiTrainingCategory } from './ai-training.classifier';
import { SaveAiTrainingJobDto, SavedAiTrainingJobView } from './dto/saved-ai-training-jobs.dto';

/** Upper bound on saved jobs per user, so the table can't grow without limit. */
export const MAX_SAVED_AI_TRAINING_JOBS = 500;

@Injectable()
export class SavedAiTrainingJobsService {
  constructor(
    @InjectRepository(SavedAiTrainingJob) private saved: Repository<SavedAiTrainingJob>,
  ) {}

  /** Everything the user has saved, newest first. */
  async list(userId: string) {
    assertValidId(userId, 'User');
    const docs = await this.saved.find({ where: { userId }, order: { savedAt: 'DESC' } });
    const jobs = docs.map(toView);
    return { total: jobs.length, jobs };
  }

  /**
   * Saves one or many jobs. Saving a job that is already saved leaves the
   * original (and its savedAt) untouched, so "Save all" can safely be pressed
   * again after more results load.
   */
  async save(userId: string, jobs: SaveAiTrainingJobDto[]) {
    assertValidId(userId, 'User');

    // Drop duplicates within the request itself.
    const unique = [...new Map(jobs.map((j) => [j.id, j])).values()];
    const ids = unique.map((j) => j.id);

    const alreadySaved = new Set(
      ids.length
        ? (
            await this.saved.find({ where: { userId, jobId: In(ids) }, select: { id: true, jobId: true } })
          ).map((d) => d.jobId)
        : [],
    );
    const fresh = unique.filter((j) => !alreadySaved.has(j.id));

    if (fresh.length) {
      const current = await this.saved.count({ where: { userId } });
      if (current + fresh.length > MAX_SAVED_AI_TRAINING_JOBS) {
        throw new BadRequestException(
          `You can keep up to ${MAX_SAVED_AI_TRAINING_JOBS} saved AI training jobs. Delete some saved jobs and try again.`,
        );
      }

      const now = new Date();
      // One INSERT; a row that already exists (unique userId + jobId) is skipped, never overwritten.
      await this.saved
        .createQueryBuilder()
        .insert()
        .values(fresh.map((j) => ({ userId, jobId: j.id, savedAt: now, ...snapshot(j) })) as any)
        .orIgnore()
        .execute();
    }

    const docs = ids.length ? await this.saved.find({ where: { userId, jobId: In(ids) } }) : [];
    // Keep the order the client sent them in.
    const byId = new Map(docs.map((d) => [d.jobId, d]));
    const saved = ids.map((id) => byId.get(id)).filter(Boolean).map((d) => toView(d!));
    return { saved: fresh.length, alreadySaved: unique.length - fresh.length, jobs: saved };
  }

  /** Deletes one saved job. Deleting something that is not saved is not an error. */
  async remove(userId: string, jobId: string) {
    assertValidId(userId, 'User');
    const res = await this.saved.delete({ userId, jobId });
    return { deleted: res.affected ?? 0 };
  }

  /** Deletes every saved job the user has. */
  async removeAll(userId: string) {
    assertValidId(userId, 'User');
    const res = await this.saved.delete({ userId });
    return { deleted: res.affected ?? 0 };
  }
}

/** The fields copied from the client's job into the stored snapshot (defensively trimmed). */
function snapshot(j: SaveAiTrainingJobDto) {
  return {
    source: j.source,
    title: j.title,
    company: j.company,
    category: j.category,
    location: j.location,
    remote: j.remote,
    employmentType: j.employmentType ?? '',
    summary: (j.summary ?? '').slice(0, 2000),
    applyUrl: j.applyUrl,
    postedAt: j.postedAt,
    pay: j.pay
      ? { min: j.pay.min, max: j.pay.max, currency: j.pay.currency, text: j.pay.text, unit: j.pay.unit }
      : undefined,
  };
}

function toView(d: any): SavedAiTrainingJobView {
  return {
    id: d.jobId,
    source: d.source,
    title: d.title,
    company: d.company ?? undefined, // Postgres returns null for an empty column; the API has always omitted it
    category: d.category as AiTrainingCategory,
    location: d.location ?? undefined,
    remote: !!d.remote,
    employmentType: d.employmentType ?? '',
    summary: d.summary ?? '',
    applyUrl: d.applyUrl,
    postedAt: d.postedAt ?? undefined,
    pay: d.pay ?? undefined,
    savedAt: new Date(d.savedAt).toISOString(),
  };
}
