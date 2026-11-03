import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

export interface InternshipDocumentData {
  appName: string;
  documentNumber: string;
  issuedAt: Date;
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
  programTitle: string;
  startedAt: Date | null;
  completedAt: Date | null;
  totals: { levels: number; projects: number; steps: number; attempts: number; xp: number; averageScore: number };
  levels: Array<{ title: string; tier: string; steps: number }>;
  projects: Array<{ title: string; role?: string; deliverables: string[]; techStack: string[] }>;
  customizeEmail: string;
}

const C = { ink: '#1a1a1a', accent: '#2d5b8e', gold: '#b7791f', muted: '#5a5a5a', rule: '#d9d9d9', soft: '#f6f8fb' };
const M = 56;

/** The built-in PDF fonts only draw Latin-1; anything else would print as garbage. */
const clean = (t: string | undefined | null) =>
  (t ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u2192\u21D2]/g, '->')
    .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\u00FF]/g, '')
    .trim();

const fmtDate = (d: Date | null) => (d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : '-');

/**
 * Renders the internship document: page 1 is the certificate of completion,
 * page 2+ the internship record (what was done: levels, projects, results).
 * Everything comes from the learner's real progress - nothing is invented.
 */
@Injectable()
export class InternshipDocumentPdfService {
  render(d: InternshipDocumentData): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: M, info: { Title: `Internship Document - ${clean(d.courseTitle)}`, Author: d.appName } });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      this.certificate(doc, d);
      this.record(doc, d);
      doc.end();
    });
  }

  private certificate(doc: PDFKit.PDFDocument, d: InternshipDocumentData) {
    const W = doc.page.width;
    const H = doc.page.height;
    doc.rect(24, 24, W - 48, H - 48).lineWidth(3).stroke(C.accent);
    doc.rect(32, 32, W - 64, H - 64).lineWidth(0.8).stroke(C.gold);

    doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(13).text(clean(d.appName).toUpperCase(), 0, 90, { align: 'center', characterSpacing: 4 });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(30).text('CERTIFICATE', 0, 150, { align: 'center' });
    doc.fontSize(15).fillColor(C.gold).text('OF INTERNSHIP COMPLETION', 0, 190, { align: 'center', characterSpacing: 3 });

    doc.moveTo(W / 2 - 60, 225).lineTo(W / 2 + 60, 225).lineWidth(1.5).stroke(C.gold);

    doc.fillColor(C.muted).font('Helvetica').fontSize(12).text('This is to certify that', 0, 260, { align: 'center' });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(32).text(clean(d.learnerName), M, 292, { align: 'center', width: W - M * 2 });

    const y = doc.y + 18;
    doc.fillColor(C.muted).font('Helvetica').fontSize(12).text('has successfully completed the AI-supervised practical internship program in', M, y, { align: 'center', width: W - M * 2 });
    doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(21).text(clean(d.courseTitle), M + 20, doc.y + 10, { align: 'center', width: W - (M + 20) * 2 });

    doc.fillColor(C.muted).font('Helvetica').fontSize(12).text(
      `completing ${d.totals.levels} practical levels and ${d.totals.projects} real-world projects (${d.totals.steps} supervised steps), under the supervision of Lora, AI Internship Supervisor.`,
      M + 10,
      doc.y + 16,
      { align: 'center', width: W - (M + 10) * 2, lineGap: 3 },
    );

    const baseY = H - 210;
    doc.moveTo(M + 20, baseY).lineTo(M + 190, baseY).lineWidth(0.8).stroke(C.rule);
    doc.moveTo(W - M - 190, baseY).lineTo(W - M - 20, baseY).stroke(C.rule);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text('Lora', M + 20, baseY + 6, { width: 170, align: 'center' });
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('AI Internship Supervisor', M + 20, baseY + 21, { width: 170, align: 'center' });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text(fmtDate(d.issuedAt), W - M - 190, baseY + 6, { width: 170, align: 'center' });
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text('Date of issue', W - M - 190, baseY + 21, { width: 170, align: 'center' });

    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(`Document No. ${d.documentNumber}`, 0, H - 120, { align: 'center' });
    doc.fontSize(7.5).text(
      `Issued by ${clean(d.appName)}. This document certifies completion of a practical training program on the ${clean(d.appName)} platform; it is not an employment record.`,
      M + 20,
      H - 100,
      { align: 'center', width: W - (M + 20) * 2 },
    );
  }

  private ensure(doc: PDFKit.PDFDocument, need: number) {
    if (doc.y + need > doc.page.height - M - 30) doc.addPage();
  }

  private heading(doc: PDFKit.PDFDocument, text: string) {
    this.ensure(doc, 50);
    doc.moveDown(0.8);
    doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(13).text(text, M, doc.y);
    const y = doc.y + 3;
    doc.moveTo(M, y).lineTo(doc.page.width - M, y).lineWidth(0.8).stroke(C.rule);
    doc.moveDown(0.6);
  }

  private record(doc: PDFKit.PDFDocument, d: InternshipDocumentData) {
    doc.addPage();
    const W = doc.page.width - M * 2;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(20).text('Internship Record', M, M);
    doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(clean(d.programTitle), M, doc.y + 2);

    // Summary box
    doc.moveDown(0.8);
    const top = doc.y;
    doc.roundedRect(M, top, W, 98, 6).fill(C.soft);
    const rows: Array<[string, string]> = [
      ['Intern', clean(d.learnerName)],
      ['Email', clean(d.learnerEmail)],
      ['Course', clean(d.courseTitle)],
      ['Duration', `${fmtDate(d.startedAt)} - ${fmtDate(d.completedAt)}`],
      ['Document No.', d.documentNumber],
    ];
    let ry = top + 10;
    rows.forEach(([k, v]) => {
      doc.fillColor(C.muted).font('Helvetica').fontSize(9.5).text(k, M + 14, ry, { width: 90 });
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(9.5).text(v, M + 110, ry, { width: W - 124 });
      ry += 16;
    });
    doc.y = top + 108;

    this.heading(doc, 'Results');
    const stats: Array<[string, string]> = [
      ['Levels completed', `${d.totals.levels}`],
      ['Projects completed', `${d.totals.projects}`],
      ['Supervised steps passed', `${d.totals.steps}`],
      ['Review submissions', `${d.totals.attempts}`],
      ['Average review score', `${d.totals.averageScore}/100`],
      ['Experience points', `${d.totals.xp} XP`],
    ];
    stats.forEach(([k, v]) => {
      const y = doc.y;
      doc.fillColor(C.muted).font('Helvetica').fontSize(10).text(k, M + 6, y, { width: 220 });
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(v, M + 230, y, { width: 200 });
      doc.y = y + 15;
    });

    this.heading(doc, 'Practical levels');
    d.levels.forEach((l, i) => {
      this.ensure(doc, 20);
      const y = doc.y;
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10).text(`${i + 1}. ${clean(l.title)}`, M + 6, y, { width: W - 170 });
      doc.fillColor(C.muted).font('Helvetica').fontSize(9.5).text(`${clean(l.tier)} - ${l.steps} steps`, M + W - 160, y, { width: 160, align: 'right' });
      doc.y = Math.max(doc.y, y + 14) + 3;
    });

    this.heading(doc, 'Real-world projects');
    d.projects.forEach((p, i) => {
      this.ensure(doc, 70);
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(10.5).text(`${i + 1}. ${clean(p.title)}`, M + 6, doc.y, { width: W - 10 });
      if (p.role) doc.fillColor(C.muted).font('Helvetica-Oblique').fontSize(9.5).text(`Role: ${clean(p.role)}`, M + 18, doc.y + 1, { width: W - 24 });
      if (p.deliverables.length) {
        doc.fillColor(C.ink).font('Helvetica').fontSize(9.5).text(`Delivered: ${p.deliverables.map(clean).join('; ')}`, M + 18, doc.y + 3, { width: W - 24, lineGap: 1.5 });
      }
      if (p.techStack.length) {
        doc.fillColor(C.accent).font('Helvetica').fontSize(9).text(`Tools: ${p.techStack.map(clean).join(', ')}`, M + 18, doc.y + 2, { width: W - 24 });
      }
      doc.moveDown(0.7);
    });

    this.ensure(doc, 60);
    doc.moveDown(1);
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(
      `Every step in this internship was completed by the intern and reviewed by Lora, the AI internship supervisor, against a pass mark of 70/100. Need a customized version of this document? Email ${clean(d.customizeEmail)} with your document number (${d.documentNumber}).`,
      M,
      doc.y,
      { width: W, lineGap: 2 },
    );
  }
}
