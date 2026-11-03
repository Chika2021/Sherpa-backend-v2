import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AutoApplyBatch } from '../entities/auto-apply-batch.entity';
import { Application } from '../entities/application.entity';
import { GeneratedDocument } from '../entities/generated-document.entity';
import { assertValidId, ownedBy } from '../database/db-utils';

const ACTIVE_STATUSES = ['QUEUED', 'RUNNING'];

@Injectable()
export class AutoApplyService {
  constructor(
    @InjectRepository(AutoApplyBatch) private batches: Repository<AutoApplyBatch>,
    @InjectRepository(Application) private applications: Repository<Application>,
    @InjectRepository(GeneratedDocument) private documents: Repository<GeneratedDocument>,
  ) {}

  /**
   * Fetches the batch plus every application in it, with each application's
   * job and generated documents attached. Uses direct queries rather than
   * nested virtual-populate (`applications` -> `documents`) - that has the
   * same reliability issue described in ApplicationsService.getDocumentsFor,
   * compounded further by being nested two levels deep.
   */
  async getStatus(userId: string, batchId: string): Promise<Record<string, any>> {
    const batch = await this.batches.findOneBy(ownedBy(batchId, userId, 'Auto-apply batch'));
    if (!batch) throw new NotFoundException('Auto-apply batch not found');

    const applications = await this.applications.find({
      where: { autoApplyBatchId: batch.id },
      relations: { job: true },
      order: { createdAt: 'ASC' },
    });

    const applicationIds = applications.map((a) => a.id);
    const allDocs = applicationIds.length
      ? await this.documents.find({ where: { applicationId: In(applicationIds) }, order: { createdAt: 'ASC' } })
      : [];

    const docsByApplication = new Map<string, any[]>();
    for (const doc of allDocs) {
      const key = String(doc.applicationId);
      const bucket = docsByApplication.get(key) || [];
      bucket.push(doc.toJSON());
      docsByApplication.set(key, bucket);
    }

    return {
      ...batch.toJSON(),
      applications: applications.map((a) => ({ ...a.toJSON(), documents: docsByApplication.get(a.id) || [] })),
    };
  }

  async listForUser(userId: string) {
    assertValidId(userId, 'User');
    return this.batches.find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async cancel(userId: string, batchId: string) {
    const owned = ownedBy(batchId, userId, 'Auto-apply batch');

    // Atomic: only a run that is still queued/running can be cancelled (one conditional UPDATE).
    const result = await this.batches.update({ ...owned, status: In(ACTIVE_STATUSES as any) }, { status: 'CANCELLED' });
    if (result.affected) return this.batches.findOneByOrFail({ id: batchId });

    const existing = await this.batches.findOneBy(owned);
    if (!existing) throw new NotFoundException('Auto-apply batch not found');
    return existing; // already finished - nothing to cancel
  }
}
