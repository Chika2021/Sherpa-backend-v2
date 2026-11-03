import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { GeminiService } from '../ai/gemini.service';
import { ResumeParserService } from './resume-parser.service';
import { Resume } from '../entities/resume.entity';
import { assertValidId, ownedBy } from '../database/db-utils';

const RESUME_SAVE_ATTEMPTS = 3;
const RESUME_SAVE_RETRY_DELAYS_MS = [300, 900];

function isTransientConnectionError(error: unknown): boolean {
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
    (typeof code === 'string' && /^(?:ECONNRESET|ETIMEDOUT|57P01|08000|08003|08006)$/.test(code)) ||
    /connection terminated unexpectedly|socket hang up/i.test(message)
  );
}

@Injectable()
export class ResumesService {
  private readonly logger = new Logger(ResumesService.name);

  constructor(
    @InjectRepository(Resume) private resumes: Repository<Resume>,
    private gemini: GeminiService,
    private parser: ResumeParserService,
  ) {}

  /** Deletes an uploaded file from disk. Never throws; refuses paths outside the upload folder. */
  private async deleteStoredFile(filePath?: string | null) {
    if (!filePath) return;
    const uploadRoot = path.resolve(process.env.UPLOAD_DIR || './uploads');
    const target = path.resolve(filePath);
    if (target !== uploadRoot && !target.startsWith(uploadRoot + path.sep)) {
      this.logger.warn(`Not deleting "${filePath}": it is outside the upload folder.`);
      return;
    }
    try {
      await fs.promises.rm(target, { force: true });
    } catch (err) {
      this.logger.warn(`Could not delete file "${target}": ${(err as Error)?.message}`);
    }
  }

  async uploadAndParse(userId: string, file: Express.Multer.File, makePrimary = true) {
    try {
      return await this.parseAndSave(userId, file, makePrimary);
    } catch (error) {
      // Don't leave an orphan file in the uploads folder when parsing/saving fails.
      await this.deleteStoredFile(file?.path);
      throw error;
    }
  }

  private async parseAndSave(userId: string, file: Express.Multer.File, makePrimary: boolean) {
    assertValidId(userId, 'User');
    const rawText = await this.parser.extractText(file.path, file.mimetype, file.originalname);
    const parsedProfile = await this.gemini.parseResume(userId, rawText);

    // Keep the ID stable across retries: a connection can drop after the transaction
    // commits but before the client receives its result.
    const resume = this.resumes.create({
      id: uuid(),
      userId,
      originalName: file.originalname,
      filePath: file.path,
      mimeType: file.mimetype,
      rawText,
      parsedProfile: parsedProfile as any,
      isPrimary: makePrimary,
    });

    for (let attempt = 1; attempt <= RESUME_SAVE_ATTEMPTS; attempt++) {
      try {
        return await this.resumes.manager.transaction(async (manager) => {
          if (makePrimary) {
            await manager.update(Resume, { userId, isPrimary: true }, { isPrimary: false });
          }
          return manager.save(Resume, resume);
        });
      } catch (error) {
        if (attempt === RESUME_SAVE_ATTEMPTS || !isTransientConnectionError(error)) {
          throw error;
        }

        const delay = RESUME_SAVE_RETRY_DELAYS_MS[attempt - 1];
        this.logger.warn(
          `Resume save hit a transient database connection error; retrying (${attempt}/${RESUME_SAVE_ATTEMPTS - 1}) in ${delay}ms.`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Resume could not be saved after retrying transient database connection errors.');
  }

  findAllForUser(userId: string) {
    assertValidId(userId, 'User');
    return this.resumes.find({
      where: { userId },
      select: { id: true, originalName: true, isPrimary: true, createdAt: true, parsedProfile: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string) {
    const resume = await this.resumes.findOneBy(ownedBy(id, userId, 'Resume'));
    if (!resume) throw new NotFoundException('Resume not found');
    return resume;
  }

  async getPrimary(userId: string) {
    assertValidId(userId, 'User');
    const resume = await this.resumes.findOne({ where: { userId, isPrimary: true } });
    if (!resume) {
      throw new NotFoundException('No primary resume set. Upload a resume first via POST /resumes.');
    }
    return resume;
  }

  async setPrimary(userId: string, id: string) {
    await this.findOne(userId, id);
    await this.resumes.manager.transaction(async (em) => {
      await em.update(Resume, { userId, isPrimary: true }, { isPrimary: false });
      await em.update(Resume, { id }, { isPrimary: true });
    });
    return this.resumes.findOneBy({ id });
  }

  async remove(userId: string, id: string) {
    const resume = await this.findOne(userId, id);

    // Delete the database row first (and promote another resume if this was the primary one) ...
    await this.resumes.manager.transaction(async (em) => {
      await em.delete(Resume, { id });
      if (resume.isPrimary) {
        const next = await em.findOne(Resume, { where: { userId }, order: { createdAt: 'DESC' }, select: { id: true } });
        if (next) await em.update(Resume, { id: next.id }, { isPrimary: true });
      }
    });

    // ... then the file in the uploads folder.
    await this.deleteStoredFile(resume.filePath);

    // Same response as before: the deleted resume.
    return resume;
  }
}
//Resume service 