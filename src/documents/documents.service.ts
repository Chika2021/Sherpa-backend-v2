import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { GeminiService, ResumeProfile } from '../ai/gemini.service';
import { GeneratedDocument } from '../entities/generated-document.entity';

@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    private storage: StorageService,
    private gemini: GeminiService,
  ) {}

  /** Generates & persists a tailored resume + cover letter for a job, as .docx files. */
  async generateApplicationDocuments(
    userId: string,
    applicationId: string,
    profile: ResumeProfile,
    job: { id: string; title: string; company: string; description: string },
  ) {
    const [resumeText, coverLetterText] = await Promise.all([
      this.gemini.generateTailoredResume(userId, profile, job),
      this.gemini.generateCoverLetter(userId, profile, job),
    ]);

    const resumeBuffer = await this.textToDocx(`Resume - ${job.title} at ${job.company}`, resumeText);
    const coverLetterBuffer = await this.textToDocx(
      `Cover Letter - ${job.title} at ${job.company}`,
      coverLetterText,
    );

    const safeSlug = `${job.company}-${job.title}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    // Unique per generation. The name used to be identical on every regeneration, so "regenerate" overwrote the
    // file and then the cleanup of the old version deleted the brand-new file too (download -> 404).
    const uniq = randomBytes(4).toString('hex');
    const resumePath = this.storage.writeGeneratedFile(
      userId,
      `resume-${safeSlug}-${applicationId}-${uniq}.docx`,
      resumeBuffer,
    );
    const coverLetterPath = this.storage.writeGeneratedFile(
      userId,
      `cover-letter-${safeSlug}-${applicationId}-${uniq}.docx`,
      coverLetterBuffer,
    );

    // Both rows are saved in one transaction, so there is never a resume without its cover letter.
    const { resumeDoc, coverLetterDoc } = await this.dataSource.transaction(async (em) => {
      const resumeDoc = await em.save(
        em.create(GeneratedDocument, { userId, applicationId, type: 'RESUME', content: resumeText, filePath: resumePath }),
      );
      const coverLetterDoc = await em.save(
        em.create(GeneratedDocument, {
          userId,
          applicationId,
          type: 'COVER_LETTER',
          content: coverLetterText,
          filePath: coverLetterPath,
        }),
      );
      return { resumeDoc, coverLetterDoc };
    });

    return {
      resume: { ...resumeDoc.toJSON(), url: this.storage.publicUrlFor(resumePath) },
      coverLetter: { ...coverLetterDoc.toJSON(), url: this.storage.publicUrlFor(coverLetterPath) },
    };
  }

  /**
   * Makes sure the .docx behind a /files/<userId>/<filename> URL exists on disk, rebuilding it from the text saved
   * in the database when it is gone. Hosts with an ephemeral disk (Render, Heroku, containers) wipe the generated
   * folder on every restart/redeploy/spin-down while the database rows survive, which is what made downloads fail.
   * Returns true when the file is present afterwards.
   */
  async restoreFileIfMissing(userId: string, filename: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return false;
    if (filename !== path.basename(filename) || !filename.toLowerCase().endsWith('.docx')) return false;

    const target = path.join(this.storage.generatedDir, userId, filename);
    if (fs.existsSync(target)) return true;

    const repo = this.dataSource.getRepository(GeneratedDocument);
    const rows = await repo.find({
      where: { userId },
      relations: { application: { job: true } },
      order: { createdAt: 'DESC' },
    });
    const doc = rows.find((d) => path.basename(d.filePath.split('\\').join('/')) === filename);
    if (!doc || !doc.content) return false;

    const job = doc.application?.job;
    const label = doc.type === 'COVER_LETTER' ? 'Cover Letter' : 'Resume';
    const title = job ? `${label} - ${job.title} at ${job.company || 'the company'}` : label;
    this.storage.writeGeneratedFile(userId, filename, await this.textToDocx(title, doc.content));
    this.logger.warn(`Rebuilt missing generated file ${filename} from the database.`);
    return true;
  }

  private async textToDocx(title: string, body: string): Promise<Buffer> {
    const paragraphs = [
      new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
      ...body.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] })),
    ];
    const doc = new Document({ sections: [{ children: paragraphs }] });
    return Packer.toBuffer(doc);
  }
}
