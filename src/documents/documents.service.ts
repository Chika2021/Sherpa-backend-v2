import { Injectable } from '@nestjs/common';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { GeminiService, ResumeProfile } from '../ai/gemini.service';
import { GeneratedDocument } from '../entities/generated-document.entity';

@Injectable()
export class DocumentsService {
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
    const resumePath = this.storage.writeGeneratedFile(
      userId,
      `resume-${safeSlug}-${applicationId}.docx`,
      resumeBuffer,
    );
    const coverLetterPath = this.storage.writeGeneratedFile(
      userId,
      `cover-letter-${safeSlug}-${applicationId}.docx`,
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

  private async textToDocx(title: string, body: string): Promise<Buffer> {
    const paragraphs = [
      new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
      ...body.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] })),
    ];
    const doc = new Document({ sections: [{ children: paragraphs }] });
    return Packer.toBuffer(doc);
  }
}
