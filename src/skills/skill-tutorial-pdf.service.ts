import { Injectable, Logger } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { SkillCourseGuide, SkillTutorial, SkillTutorialModule } from '../ai/gemini.service';
import { MIN_MODULE_PAGES } from '../ai/tutorial-depth';

const COLORS = {
  primary: '#1a1a1a',
  accent: '#2d5b8e',
  muted: '#5a5a5a',
  rule: '#dddddd',
  white: '#ffffff',
  codeBg: '#f3f5f7',
  codeText: '#1f2937',
  inlineCode: '#9a3412',
  quoteBg: '#eef4fb',
  boxBg: '#f6f8fb',
};

// One colour per difficulty tier, so a module's banner shows where it sits in the arc.
const TIER_COLORS: Record<string, string> = {
  Beginner: '#2f855a',
  Intermediate: '#2b6cb0',
  Advanced: '#b7791f',
  'Super Advanced': '#9b2c2c',
};

const MARGIN = 56;
const BODY_SIZE = 10.5;
const BODY_GAP = 2.5;

export interface RenderedTutorial {
  buffer: Buffer;
  totalPages: number;
  /** Printed pages each module took, in module order (every module starts on a fresh page). */
  modulePages: number[];
}

@Injectable()
export class SkillTutorialPdfService {
  private readonly logger = new Logger(SkillTutorialPdfService.name);

  /** Renders a generated tutorial into a downloadable PDF and returns the finished buffer. */
  async render(tutorial: SkillTutorial): Promise<Buffer> {
    return (await this.renderWithStats(tutorial)).buffer;
  }

  /** Same as `render`, plus how many pages the document and each module came to. */
  async renderWithStats(tutorial: SkillTutorial): Promise<RenderedTutorial> {
    const result = await new TutorialPdfWriter(tutorial).build();
    const short = result.modulePages
      .map((pages, i) => ({ pages, heading: tutorial.modules[i]?.heading, number: i + 1 }))
      .filter((m) => m.pages < MIN_MODULE_PAGES);
    if (short.length) {
      this.logger.warn(
        `"${tutorial.title}": ${short.length} module(s) printed under ${MIN_MODULE_PAGES} pages - ` +
          short.map((m) => `#${m.number} "${m.heading}" = ${m.pages}`).join('; ') +
          '. POST /skills/:id/material will rewrite thin modules.',
      );
    }
    return result;
  }
}

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'bullet'; depth: number; text: string }
  | { kind: 'number'; depth: number; marker: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

/** Replaces characters the built-in PDF fonts can't draw (arrows, ticks, emoji...) so they never print as garbage. */
function clean(text: string | undefined | null): string {
  return (text ?? '')
    .replace(/[\u2192\u21D2\u27F6]/g, '->')
    .replace(/[\u2190\u21D0]/g, '<-')
    .replace(/\u2194/g, '<->')
    .replace(/[\u2713\u2714\u2705]/g, '[x]')
    .replace(/[\u2717\u2718\u274C]/g, '[ ]')
    .replace(/\u2265/g, '>=')
    .replace(/\u2264/g, '<=')
    .replace(/\u2260/g, '!=')
    .replace(/\u2248/g, '~')
    .replace(/\u221E/g, 'infinity')
    .replace(/[\u2212\u2010\u2011\u2012]/g, '-')
    .replace(/[\u00A0\u2007\u202F\u2009\u200A]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\t/g, '  ')
    .replace(/[^\n\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC\u2122]/g, '');
}

function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s](?:[^*]*[^*\s])?)\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[1] !== undefined) runs.push({ text: match[1].replace(/`/g, ''), bold: true });
    else if (match[2] !== undefined) runs.push({ text: match[2], code: true });
    else runs.push({ text: match[3], italic: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.filter((run) => run.text.length > 0);
}

const plainText = (text: string) => parseInline(text).map((run) => run.text).join('');

function parseMarkdown(markdown: string): Block[] {
  const lines = clean(markdown).replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  const isStructural = (line: string) =>
    /^\s*```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*[-*+\u2022]\s+/.test(line) ||
    /^\s*\d+[.)]\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^\s*\|.*\|\s*$/.test(line) ||
    /^\s*([-*_])\1{2,}\s*$/.test(line);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence (or end of input for an unclosed one)
      blocks.push({ kind: 'code', text: code.join('\n') });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    // Tables are not part of the lesson format, but a model may still emit one: keep it readable as monospace.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      blocks.push({ kind: 'code', text: rows.join('\n') });
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', text: quoted.join(' ').trim() });
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+\u2022]\s+(.*)$/);
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const indent = (bullet ?? numbered)![1].length;
      let text = bullet ? bullet[2] : numbered![3];
      i++;
      // Indented lines that follow belong to the same item.
      while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !isStructural(lines[i])) {
        text += ` ${lines[i++].trim()}`;
      }
      const depth = Math.min(3, Math.floor(indent / 2));
      blocks.push(bullet ? { kind: 'bullet', depth, text } : { kind: 'number', depth, marker: `${numbered![2]}.`, text });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && (paragraph.length === 0 || !isStructural(lines[i]))) {
      paragraph.push(lines[i++].trim());
    }
    blocks.push({ kind: 'para', text: paragraph.join(' ') });
  }
  return blocks;
}

class TutorialPdfWriter {
  private readonly doc: PDFKit.PDFDocument;
  private readonly left = MARGIN;
  private readonly width: number;
  private readonly chunks: Buffer[] = [];
  private readonly finished: Promise<Buffer>;
  // Footer label per page (index = page index); pages added by overflow inherit the current label.
  private readonly labels: string[] = [''];
  private currentLabel = '';

  constructor(private readonly tutorial: SkillTutorial) {
    this.doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: { Title: tutorial.title, Subject: `${tutorial.title} - a complete course` },
    });
    this.width = this.doc.page.width - MARGIN * 2;
    this.doc.on('pageAdded', () => this.labels.push(this.currentLabel));
    this.doc.on('data', (chunk: Buffer) => this.chunks.push(chunk));
    this.finished = new Promise<Buffer>((resolve, reject) => {
      this.doc.on('end', () => resolve(Buffer.concat(this.chunks)));
      this.doc.on('error', reject);
    });
  }

  async build(): Promise<RenderedTutorial> {
    const { tutorial } = this;
    const guide = tutorial.courseGuide;

    this.cover();
    this.aboutPages(guide);

    // Reserve the contents page now; its page numbers are filled in once every module's start page is known.
    this.newPage('Contents');
    const contentsPage = this.pageIndex();

    const startPages: number[] = [];
    const modulePages: number[] = [];
    tutorial.modules.forEach((module, index) => {
      this.newPage(`Module ${index + 1}: ${module.heading}`);
      const start = this.pageIndex();
      startPages.push(start);
      this.moduleBody(module, index, tutorial.modules.length);
      modulePages.push(this.pageIndex() - start + 1);
    });

    this.backMatter(guide);
    this.contents(contentsPage, startPages);
    this.footers();

    const totalPages = this.pageIndex() + 1;
    this.doc.end();
    return { buffer: await this.finished, totalPages, modulePages };
  }

  // ---------- page plumbing ----------

  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  private pageIndex(): number {
    const range = this.doc.bufferedPageRange();
    return range.start + range.count - 1;
  }

  private newPage(label: string) {
    this.currentLabel = label;
    this.doc.addPage();
  }

  /** Starts a fresh page if less than `needed` points remain on this one. */
  private ensureSpace(needed: number) {
    if (this.doc.y + needed > this.bottom) this.doc.addPage();
    this.doc.x = this.left;
  }

  private gap(points: number) {
    this.doc.y += points;
    this.doc.x = this.left;
  }

  private bodyLine(): number {
    this.doc.font('Helvetica').fontSize(BODY_SIZE);
    return this.doc.currentLineHeight(true) + BODY_GAP;
  }

  // ---------- front matter ----------

  private cover() {
    const { doc, tutorial } = this;
    const bandHeight = 300;
    doc.rect(0, 0, doc.page.width, bandHeight).fill(COLORS.accent);

    doc.fillColor('#cfe0f3').font('Helvetica-Bold').fontSize(10).text('A COMPLETE SELF-PACED COURSE', this.left, 96, {
      width: this.width,
      characterSpacing: 2,
    });
    doc.fillColor(COLORS.white).font('Helvetica-Bold').fontSize(34).text(clean(tutorial.title), this.left, 124, {
      width: this.width,
      lineGap: 4,
    });

    const modules = tutorial.modules.length;
    const hours = Math.max(1, Math.round((tutorial.estimatedMinutes || 0) / 60));
    doc.fillColor('#e6eef8').font('Helvetica').fontSize(12).text(
      `Starting level: ${clean(tutorial.level)}   |   ${modules} modules   |   about ${hours} hour${hours === 1 ? '' : 's'} of study`,
      this.left,
      bandHeight - 56,
      { width: this.width },
    );

    doc.y = bandHeight + 36;
    doc.x = this.left;
    if (tutorial.overview) {
      this.sectionLabel('OVERVIEW');
      this.writeRuns(parseInline(clean(tutorial.overview)), { size: 12, color: COLORS.primary, gap: 4 });
    }

    // Tier-by-tier snapshot: how the course climbs from the learner's starting point.
    const tiers = this.tierCounts();
    if (tiers.length) {
      this.gap(18);
      this.sectionLabel('THE LEARNING PATH');
      tiers.forEach(({ tier, count }) => {
        const y = this.doc.y;
        doc.rect(this.left, y + 3, 8, 8).fill(TIER_COLORS[tier] ?? COLORS.accent);
        doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(11).text(tier, this.left + 16, y, { continued: true });
        doc.font('Helvetica').fillColor(COLORS.muted).text(`   ${count} module${count === 1 ? '' : 's'}`);
        this.gap(3);
      });
    }
  }

  private tierCounts(): Array<{ tier: string; count: number }> {
    const counts = new Map<string, number>();
    this.tutorial.modules.forEach((m) => counts.set(m.tier, (counts.get(m.tier) ?? 0) + 1));
    return Array.from(counts, ([tier, count]) => ({ tier, count }));
  }

  private aboutPages(guide?: SkillCourseGuide) {
    const hasGuide =
      guide && (guide.audience || guide.prerequisites?.length || guide.learningOutcomes?.length || guide.howToUseThisCourse);
    if (!hasGuide) return;
    this.newPage('About this course');
    this.pageTitle('About This Course');

    if (guide.audience) {
      this.subTitle('Who this course is for');
      this.paragraphs(guide.audience);
    }
    if (guide.prerequisites?.length) {
      this.subTitle('Prerequisites');
      this.bulletList(guide.prerequisites);
    }
    if (guide.learningOutcomes?.length) {
      this.subTitle('What you will be able to do');
      this.bulletList(guide.learningOutcomes);
    }
    if (guide.howToUseThisCourse) {
      this.subTitle('How to use this course');
      this.paragraphs(guide.howToUseThisCourse);
    }
  }

  /** Fills in the reserved contents page: every module with its tier and the page it starts on. */
  private contents(pageIndex: number, startPages: number[]) {
    const { doc } = this;
    doc.switchToPage(pageIndex);
    doc.x = this.left;
    doc.y = doc.page.margins.top;
    this.pageTitle('Contents');

    const modules = this.tutorial.modules;
    const available = this.bottom - doc.y - 8;
    const rowHeight = Math.max(11, Math.min(26, available / Math.max(1, modules.length + 1)));
    const size = rowHeight >= 20 ? 11 : 9;

    modules.forEach((module, i) => {
      const y = doc.y;
      const color = TIER_COLORS[module.tier] ?? COLORS.accent;
      doc.rect(this.left, y + 2, 3, rowHeight - 6).fill(color);
      doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(size).text(String(i + 1).padStart(2, '0'), this.left + 12, y, {
        width: 24,
        lineBreak: false,
      });
      doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(size).text(this.fit(module.heading, 70), this.left + 40, y, {
        width: this.width - 150,
        lineBreak: false,
      });
      doc.fillColor(color).font('Helvetica').fontSize(size - 1.5).text(module.tier.toUpperCase(), this.left + this.width - 110, y + 1, {
        width: 80,
        lineBreak: false,
        align: 'right',
      });
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(size).text(String(startPages[i] + 1), this.left + this.width - 24, y, {
        width: 24,
        lineBreak: false,
        align: 'right',
      });
      doc.y = y + rowHeight;
    });

    doc.x = this.left;
    const extras: string[] = [];
    const guide = this.tutorial.courseGuide;
    if (guide?.capstone?.title || guide?.capstone?.brief) extras.push('Capstone project');
    if (guide?.quickReference) extras.push('Quick reference');
    if (guide?.glossary?.length) extras.push('Glossary');
    if (guide?.nextSteps?.length) extras.push('Where to go next');
    if (extras.length) {
      this.gap(10);
      doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(9.5).text(`Also included after the modules: ${extras.join(', ')}.`, this.left, doc.y, {
        width: this.width,
        lineBreak: false,
      });
    }
  }

  // ---------- one module ----------

  private moduleBody(module: SkillTutorialModule, index: number, total: number) {
    const { doc } = this;
    const color = TIER_COLORS[module.tier] ?? COLORS.accent;

    // Banner
    const heading = clean(module.heading);
    doc.font('Helvetica-Bold').fontSize(21);
    const headingHeight = doc.heightOfString(heading, { width: this.width - 36 });
    const bannerHeight = 18 + 12 + 8 + headingHeight + 18;
    const top = doc.y;
    doc.rect(this.left, top, this.width, bannerHeight).fill(color);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(9).text(
      `MODULE ${index + 1} OF ${total}   |   ${clean(module.tier).toUpperCase()}`,
      this.left + 18,
      top + 18,
      { width: this.width - 36, characterSpacing: 1.2, lineBreak: false },
    );
    doc.font('Helvetica-Bold').fontSize(21).fillColor('#ffffff').text(heading, this.left + 18, top + 38, { width: this.width - 36 });
    doc.y = top + bannerHeight + 16;
    doc.x = this.left;

    // At a glance: the spoken summary, key points and example.
    if (module.narration) {
      this.sectionLabel('IN THIS MODULE');
      this.writeRuns(parseInline(clean(module.narration)), { size: 11, color: COLORS.primary, italic: true, gap: 3 });
      this.gap(8);
    }
    if (module.keyPoints?.length) this.keyPointsBox(module.keyPoints);
    if (module.example) {
      this.sectionLabel('EXAMPLE');
      this.codeBlock(module.example);
      this.gap(6);
    }

    if (module.detailedMaterial) {
      this.gap(6);
      this.divider();
      this.markdown(module.detailedMaterial);
    }
  }

  private keyPointsBox(points: string[]) {
    const { doc } = this;
    const inner = this.width - 32;
    doc.font('Helvetica').fontSize(10.5);
    const items = points.map((p) => clean(p));
    const heights = items.map((p) => doc.heightOfString(p, { width: inner - 14, lineGap: 1.5 }) + 3);
    const total = 30 + heights.reduce((a, b) => a + b, 0) + 6;
    this.ensureSpace(Math.min(total, 220));

    const top = doc.y;
    doc.rect(this.left, top, this.width, total).fill(COLORS.boxBg);
    doc.rect(this.left, top, 3, total).fill(COLORS.accent);
    doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(9).text('KEY POINTS', this.left + 16, top + 12, {
      characterSpacing: 1.2,
      lineBreak: false,
    });
    let y = top + 28;
    items.forEach((point, i) => {
      doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(10.5).text('\u2022', this.left + 16, y, { lineBreak: false });
      doc.fillColor(COLORS.primary).font('Helvetica').fontSize(10.5).text(point, this.left + 30, y, { width: inner - 14, lineGap: 1.5 });
      y += heights[i];
    });
    doc.y = top + total + 10;
    doc.x = this.left;
  }

  // ---------- back matter ----------

  private backMatter(guide?: SkillCourseGuide) {
    if (!guide) return;

    const capstone = guide.capstone;
    if (capstone?.title || capstone?.brief) {
      this.newPage('Capstone project');
      this.pageTitle('Capstone Project');
      if (capstone.title) {
        this.doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(14).text(clean(capstone.title), this.left, this.doc.y, { width: this.width });
        this.gap(6);
      }
      if (capstone.brief) this.paragraphs(capstone.brief);
      if (capstone.deliverables?.length) {
        this.subTitle('Deliverables');
        this.bulletList(capstone.deliverables);
      }
      if (capstone.successCriteria?.length) {
        this.subTitle('How you will know you have succeeded');
        this.bulletList(capstone.successCriteria);
      }
    }

    if (guide.quickReference) {
      this.newPage('Quick reference');
      this.pageTitle('Quick Reference');
      this.markdown(guide.quickReference);
    }

    if (guide.glossary?.length) {
      this.newPage('Glossary');
      this.pageTitle('Glossary');
      [...guide.glossary]
        .sort((a, b) => a.term.localeCompare(b.term))
        .forEach(({ term, definition }) => {
          this.ensureSpace(46);
          this.writeRuns(parseInline(`**${clean(term).replace(/\*/g, '')}**  -  ${clean(definition)}`), {
            size: BODY_SIZE,
            color: COLORS.primary,
            gap: BODY_GAP,
          });
          this.gap(5);
        });
    }

    if (guide.nextSteps?.length) {
      if (guide.glossary?.length) this.ensureSpace(120);
      else {
        this.newPage('Where to go next');
        this.pageTitle('Where to Go Next');
      }
      this.subTitle('Where to go next');
      this.bulletList(guide.nextSteps);
    }
  }

  // ---------- footers ----------

  private footers() {
    const { doc } = this;
    const range = doc.bufferedPageRange();
    const total = range.start + range.count;
    for (let i = range.start + 1; i < total; i++) {
      doc.switchToPage(i);
      const margins = doc.page.margins;
      const savedBottom = margins.bottom;
      margins.bottom = 0; // otherwise drawing inside the margin makes pdfkit add a page
      const y = doc.page.height - 36;
      doc.moveTo(this.left, y - 8).lineTo(this.left + this.width, y - 8).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8);
      doc.text(this.fit(`${this.tutorial.title}  |  ${this.labels[i] ?? ''}`, 95), this.left, y, {
        width: this.width - 70,
        lineBreak: false,
      });
      doc.text(`Page ${i + 1} of ${total}`, this.left, y, { width: this.width, align: 'right', lineBreak: false });
      margins.bottom = savedBottom;
    }
  }

  // ---------- markdown typesetting ----------

  private markdown(markdown: string) {
    for (const block of parseMarkdown(markdown)) {
      switch (block.kind) {
        case 'heading':
          this.heading(block.level, block.text);
          break;
        case 'para':
          this.paragraph(block.text);
          break;
        case 'bullet':
          this.listItem('\u2022', block.depth, block.text);
          break;
        case 'number':
          this.listItem(block.marker, block.depth, block.text);
          break;
        case 'quote':
          this.quote(block.text);
          break;
        case 'code':
          this.codeBlock(block.text);
          this.gap(6);
          break;
        case 'rule':
          this.divider();
          break;
      }
    }
  }

  private heading(level: number, raw: string) {
    const { doc } = this;
    const text = clean(plainText(raw));
    if (level <= 2) {
      doc.font('Helvetica-Bold').fontSize(15);
      const h = doc.heightOfString(text, { width: this.width });
      this.ensureSpace(h + 14 + this.bodyLine() * 3);
      this.gap(12);
      doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(15).text(text, this.left, doc.y, { width: this.width });
      this.gap(2);
      const y = doc.y;
      doc.moveTo(this.left, y).lineTo(this.left + this.width, y).lineWidth(0.75).strokeColor(COLORS.rule).stroke();
      this.gap(8);
    } else if (level === 3) {
      doc.font('Helvetica-Bold').fontSize(12);
      const h = doc.heightOfString(text, { width: this.width });
      this.ensureSpace(h + 8 + this.bodyLine() * 3);
      this.gap(8);
      doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(12).text(text, this.left, doc.y, { width: this.width });
      this.gap(4);
    } else {
      this.ensureSpace(this.bodyLine() * 4);
      this.gap(4);
      doc.fillColor(COLORS.muted).font('Helvetica-BoldOblique').fontSize(BODY_SIZE).text(text, this.left, doc.y, { width: this.width });
      this.gap(3);
    }
  }

  private paragraph(text: string) {
    const plain = plainText(text);
    this.doc.font('Helvetica').fontSize(BODY_SIZE);
    const full = this.doc.heightOfString(plain, { width: this.width, lineGap: BODY_GAP });
    this.ensureSpace(Math.min(full, this.bodyLine() * 3)); // no one-line widows at the foot of a page
    this.writeRuns(parseInline(text), { size: BODY_SIZE, color: COLORS.primary, gap: BODY_GAP });
    this.gap(6);
  }

  private listItem(marker: string, depth: number, text: string) {
    const { doc } = this;
    const indent = depth * 16;
    const markerWidth = marker.length > 1 ? 20 : 12;
    const textX = this.left + indent + markerWidth + 4;
    const textWidth = this.width - indent - markerWidth - 4;

    doc.font('Helvetica').fontSize(BODY_SIZE);
    const full = doc.heightOfString(plainText(text), { width: textWidth, lineGap: BODY_GAP });
    this.ensureSpace(Math.min(full, this.bodyLine() * 2));

    const y = doc.y;
    doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(BODY_SIZE).text(marker, this.left + indent + 2, y, { lineBreak: false });
    this.writeRuns(parseInline(text), { size: BODY_SIZE, color: COLORS.primary, gap: BODY_GAP, x: textX, y, width: textWidth });
    this.gap(3);
  }

  private quote(text: string) {
    const { doc } = this;
    const inner = this.width - 26;
    doc.font('Helvetica-Oblique').fontSize(10);
    const height = doc.heightOfString(plainText(text), { width: inner, lineGap: 2 }) + 16;
    this.ensureSpace(Math.min(height, 160));
    const top = doc.y;
    const room = this.bottom - top;
    if (height <= room) {
      doc.rect(this.left, top, this.width, height).fill(COLORS.quoteBg);
      doc.rect(this.left, top, 3, height).fill(COLORS.accent);
    }
    this.writeRuns(parseInline(text), { size: 10, color: COLORS.primary, italic: true, gap: 2, x: this.left + 16, y: top + 8, width: inner });
    doc.y = Math.max(doc.y, top + height) + 4;
    this.gap(6);
  }

  /** A shaded monospace block. Long code is split across pages line by line so it never runs off the page. */
  private codeBlock(code: string) {
    const { doc } = this;
    const lines = clean(code).replace(/\s+$/, '').split('\n');
    const size = 8.6;
    const inner = this.width - 24;
    doc.font('Courier').fontSize(size);
    const heights = lines.map((line) => doc.heightOfString(line || ' ', { width: inner, lineGap: 1.5 }));

    let start = 0;
    while (start < lines.length) {
      const available = this.bottom - doc.y - 14;
      let end = start;
      let used = 0;
      while (end < lines.length && used + heights[end] <= available) used += heights[end++];

      if (end === start) {
        doc.addPage(); // not even one line fits here
        doc.x = this.left;
        continue;
      }

      const boxHeight = used + 14;
      const top = doc.y;
      doc.rect(this.left, top, this.width, boxHeight).fill(COLORS.codeBg);
      doc.rect(this.left, top, 3, boxHeight).fill(COLORS.accent);
      doc.fillColor(COLORS.codeText).font('Courier').fontSize(size);
      doc.text(lines.slice(start, end).join('\n'), this.left + 14, top + 7, { width: inner, lineGap: 1.5 });
      doc.y = top + boxHeight + 2;
      doc.x = this.left;

      start = end;
      if (start < lines.length) {
        doc.addPage();
        doc.x = this.left;
      }
    }
  }

  // ---------- small building blocks ----------

  private pageTitle(text: string) {
    const { doc } = this;
    doc.fillColor(COLORS.primary).font('Helvetica-Bold').fontSize(24).text(clean(text), this.left, doc.y, { width: this.width });
    this.gap(4);
    const y = doc.y;
    doc.moveTo(this.left, y).lineTo(this.left + this.width, y).lineWidth(1.5).strokeColor(COLORS.accent).stroke();
    this.gap(16);
  }

  private subTitle(text: string) {
    this.ensureSpace(60);
    this.gap(8);
    this.doc.fillColor(COLORS.accent).font('Helvetica-Bold').fontSize(13).text(clean(text), this.left, this.doc.y, { width: this.width });
    this.gap(5);
  }

  private sectionLabel(text: string) {
    this.ensureSpace(40);
    this.doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(9).text(text, this.left, this.doc.y, {
      width: this.width,
      characterSpacing: 1.2,
    });
    this.gap(4);
  }

  private divider() {
    this.ensureSpace(20);
    const y = this.doc.y + 2;
    this.doc.moveTo(this.left, y).lineTo(this.left + this.width, y).lineWidth(1).strokeColor(COLORS.rule).stroke();
    this.gap(12);
  }

  private paragraphs(text: string) {
    clean(text)
      .split(/\n{2,}/)
      .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
      .forEach((p) => this.paragraph(p));
  }

  private bulletList(items: string[]) {
    items.forEach((item) => this.listItem('\u2022', 0, clean(item)));
    this.gap(4);
  }

  private fit(text: string, maxChars: number): string {
    const t = clean(text);
    return t.length > maxChars ? `${t.slice(0, maxChars - 3)}...` : t;
  }

  /**
   * Writes a paragraph of mixed bold / italic / code runs. pdfkit has no inline
   * markup, so each run is its own `continued` text call with the right font.
   */
  private writeRuns(
    runs: Run[],
    o: { size: number; color: string; gap: number; italic?: boolean; x?: number; y?: number; width?: number },
  ) {
    const { doc } = this;
    if (!runs.length) return;
    const x = o.x ?? this.left;
    const width = o.width ?? this.width;

    runs.forEach((run, i) => {
      const font = run.code
        ? 'Courier'
        : run.bold && (run.italic || o.italic)
          ? 'Helvetica-BoldOblique'
          : run.bold
            ? 'Helvetica-Bold'
            : run.italic || o.italic
              ? 'Helvetica-Oblique'
              : 'Helvetica';
      doc.font(font).fontSize(run.code ? o.size - 0.8 : o.size).fillColor(run.code ? COLORS.inlineCode : o.color);
      const options = { width, lineGap: o.gap, continued: i < runs.length - 1 };
      if (i === 0) doc.text(run.text, x, o.y ?? doc.y, options);
      else doc.text(run.text, options);
    });
    doc.x = this.left;
  }
}
