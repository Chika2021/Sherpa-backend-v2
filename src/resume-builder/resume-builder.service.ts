import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import { GeneratedResume } from '../entities/generated-resume.entity';
import { GeminiService, ResumeProfile } from '../ai/gemini.service';
import { ResumesService } from '../resumes/resumes.service';
import { StorageService } from '../storage/storage.service';
import { ResumePdfService } from './resume-pdf.service';
import { GenerateResumeDto } from './dto/generate-resume.dto';
import { assertValidId, ownedBy } from '../database/db-utils';

@Injectable()
export class ResumeBuilderService {
  constructor(
    @InjectRepository(GeneratedResume) private generatedResumes: Repository<GeneratedResume>,
    private gemini: GeminiService,
    private resumesService: ResumesService,
    private storage: StorageService,
    private pdf: ResumePdfService,
  ) {}

  /**
   * The AI resume maker: builds a polished, complete resume either from an
   * existing uploaded resume (resumeId) or from freeform details typed
   * directly (rawDetails), optionally tailored toward a target role. Persists
   * the structured result and its rendered PDF.
   */
  async generate(userId: string, dto: GenerateResumeDto) {
    if (!dto.resumeId && !dto.rawDetails) {
      throw new BadRequestException(
        'Provide either resumeId (an uploaded resume to build from) or rawDetails (freeform career details).',
      );
    }

    let baseProfile: ResumeProfile;
    let sourceResumeId: string | undefined;

    if (dto.resumeId) {
      const resume = await this.resumesService.findOne(userId, dto.resumeId);
      if (!resume.parsedProfile) {
        throw new BadRequestException('That resume has no parsed profile yet.');
      }
      baseProfile = resume.parsedProfile as ResumeProfile;
      sourceResumeId = resume.id;
    } else {
      baseProfile = await this.gemini.parseResume(userId, dto.rawDetails!);
    }

    const profile = await this.gemini.buildResume(userId, baseProfile, dto.targetRole);

    const title =
      dto.title?.trim() ||
      [profile.headline || profile.fullName || 'Resume', dto.targetRole].filter(Boolean).join(' – ');

    const record = await this.generatedResumes.save(
      this.generatedResumes.create({
        userId,
        sourceResumeId,
        targetRole: dto.targetRole,
        title,
        profile,
      }),
    );

    const pdfBuffer = await this.pdf.render(profile, title);
    record.pdfPath = this.storage.writeGeneratedFile(userId, `resume-${record.id}.pdf`, pdfBuffer);
    await this.generatedResumes.update({ id: record.id }, { pdfPath: record.pdfPath });

    return record;
  }

  findAllForUser(userId: string) {
    assertValidId(userId, 'User');
    return this.generatedResumes.find({
      where: { userId },
      select: { id: true, title: true, targetRole: true, createdAt: true },
      order: { createdAt: 'DESC' },
    });
  }

  async findOne(userId: string, id: string) {
    const record = await this.generatedResumes.findOneBy(ownedBy(id, userId, 'Generated resume'));
    if (!record) throw new NotFoundException('Generated resume not found');
    return record;
  }

  async remove(userId: string, id: string) {
    const record = await this.findOne(userId, id);
    if (record.pdfPath && fs.existsSync(record.pdfPath)) {
      fs.unlinkSync(record.pdfPath);
    }
    await this.generatedResumes.delete({ id: record.id });
    return { deleted: true };
  }

  /** Returns the on-disk path + a client-friendly filename for download, regenerating the PDF if it's missing. */
  async getPdfForDownload(userId: string, id: string): Promise<{ path: string; filename: string }> {
    const record = await this.findOne(userId, id);

    if (!record.pdfPath || !fs.existsSync(record.pdfPath)) {
      const buffer = await this.pdf.render(record.profile as ResumeProfile, record.title);
      record.pdfPath = this.storage.writeGeneratedFile(userId, `resume-${record.id}.pdf`, buffer);
      await this.generatedResumes.update({ id: record.id }, { pdfPath: record.pdfPath });
    }

    const filename = `${record.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`;
    return { path: record.pdfPath!, filename };
  }
}
