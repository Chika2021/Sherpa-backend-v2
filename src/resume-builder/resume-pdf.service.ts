import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { ResumeProfile } from '../ai/gemini.service';

const COLORS = {
  primary: '#1a1a1a',
  accent: '#2d5b8e',
  muted: '#5a5a5a',
  rule: '#dddddd',
};

@Injectable()
export class ResumePdfService {
  /** Renders a ResumeProfile into a single-page-friendly PDF and returns the finished buffer. */
  render(profile: ResumeProfile, fallbackTitle: string): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 56, right: 56 },
      info: { Title: profile.fullName || fallbackTitle },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.draw(doc, profile, fallbackTitle);
    doc.end();

    return done;
  }

  private draw(doc: PDFKit.PDFDocument, profile: ResumeProfile, fallbackTitle: string) {
    doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(22).text(profile.fullName || fallbackTitle);

    if (profile.headline) {
      doc.moveDown(0.2).fillColor(COLORS.accent).font('Helvetica').fontSize(12).text(profile.headline);
    }

    const contactParts = [profile.email, profile.phone, profile.location].filter(Boolean);
    if (contactParts.length) {
      doc.moveDown(0.3).fillColor(COLORS.muted).font('Helvetica').fontSize(10).text(contactParts.join('   ·   '));
    }

    doc.moveDown(0.8);
    this.divider(doc);

    if (profile.summary) {
      this.sectionHeading(doc, 'Summary');
      doc.fillColor(COLORS.primary).font('Helvetica').fontSize(10.5).text(profile.summary);
      doc.moveDown(0.8);
    }

    if (profile.skills?.length) {
      this.sectionHeading(doc, 'Skills');
      doc.fillColor(COLORS.primary).font('Helvetica').fontSize(10.5).text(profile.skills.join('   •   '));
      doc.moveDown(0.8);
    }

    if (profile.experience?.length) {
      this.sectionHeading(doc, 'Experience');
      for (const job of profile.experience) {
        this.keepTogether(doc, () => {
          doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(11).text(`${job.title} — ${job.company}`);
          const dates = [job.startDate, job.endDate].filter(Boolean).join(' – ');
          if (dates) {
            doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9.5).text(dates);
          }
          if (job.description) {
            doc.moveDown(0.15).fillColor(COLORS.primary).font('Helvetica').fontSize(10.5).text(job.description);
          }
        });
        doc.moveDown(0.6);
      }
    }

    if (profile.education?.length) {
      this.sectionHeading(doc, 'Education');
      for (const edu of profile.education) {
        this.keepTogether(doc, () => {
          doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(11).text(edu.school);
          const line = [edu.degree, edu.field].filter(Boolean).join(', ');
          if (line) doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10).text(line);
          if (edu.year) doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9.5).text(edu.year);
        });
        doc.moveDown(0.5);
      }
    }
  }

  private sectionHeading(doc: PDFKit.PDFDocument, text: string) {
    doc
      .fillColor(COLORS.accent)
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(text.toUpperCase(), { characterSpacing: 0.5 });
    doc.moveDown(0.25);
  }

  private divider(doc: PDFKit.PDFDocument) {
    const y = doc.y;
    doc
      .moveTo(doc.page.margins.left, y)
      .lineTo(doc.page.width - doc.page.margins.right, y)
      .strokeColor(COLORS.rule)
      .lineWidth(1)
      .stroke();
    doc.moveDown(0.6);
  }

  /** Adds a page break before a block if it would otherwise be split awkwardly across pages. */
  private keepTogether(doc: PDFKit.PDFDocument, draw: () => void) {
    const before = doc.y;
    const spaceLeft = doc.page.height - doc.page.margins.bottom - before;
    if (spaceLeft < 70) {
      doc.addPage();
    }
    draw();
  }
}
