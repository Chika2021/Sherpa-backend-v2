import { BadRequestException, Injectable, Logger } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pdfParse = require('pdf-parse');
import * as mammoth from 'mammoth';
import { PDFDocument } from 'pdf-lib';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { detectResumeKind, SUPPORTED_RESUME_MESSAGE } from './resume-file-types';

// pdfjs-dist is an ES-module-only package, but this app is compiled to CommonJS (where TypeScript would turn a plain
// `import()` into `require()` and break). Going through `new Function` keeps it a real dynamic import.
const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>;
const MAX_PDF_PAGES = 50;

// pdf-parse bundles three copies of pdf.js. Its default (v1.10.100) is the oldest and throws a bare
// "UnknownErrorException" on many modern PDFs, so if it fails the newer bundled builds are tried.
const PDF_ENGINES: Array<string | undefined> = [undefined, 'v2.0.550', 'v1.9.426'];

@Injectable()
export class ResumeParserService {
  private readonly logger = new Logger(ResumeParserService.name);

  async extractText(filePath: string, mimeType: string, originalName?: string): Promise<string> {
    const buffer = fs.readFileSync(filePath);
    const kind = detectResumeKind(originalName ?? filePath, mimeType);

    switch (kind) {
      case 'pdf':
        return this.extractPdfText(buffer);
      case 'docx':
      case 'doc': {
        try {
          const { value } = await mammoth.extractRawText({ buffer });
          if (!value.trim()) throw new Error('empty');
          return value;
        } catch (err) {
          this.logger.warn(`Word extraction failed (${(err as Error)?.message})`);
          throw new BadRequestException(
            kind === 'doc'
              ? 'Older .doc files cannot be read reliably. Please re-save it as .docx or PDF and upload again.'
              : 'We could not read this Word document. Please re-save it as .docx or PDF and try again.',
          );
        }
      }
      case 'rtf':
        return this.rtfToText(buffer.toString('latin1'));
      case 'txt':
        return buffer.toString('utf-8');
      default:
        throw new BadRequestException(SUPPORTED_RESUME_MESSAGE);
    }
  }

  /** Minimal RTF -> text (good enough for resumes; drops control words/groups). */
  private rtfToText(rtf: string): string {
    return rtf
      .replace(/\\'([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\{\\\*[^{}]*\}/g, '')
      .replace(/\\par[d]?/g, '\n')
      .replace(/\\[a-z]+-?\d* ?/gi, '')
      .replace(/[{}]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private async extractPdfText(buffer: Buffer): Promise<string> {
    // 1) Current pdf.js (pdfjs-dist). Unlike the 2018-era pdf.js inside pdf-parse it rebuilds a damaged
    // cross-reference table ("bad XRef entry") on its own, so it reads PDFs that the old engines reject.
    try {
      return await this.readPdfModern(buffer);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`pdfjs-dist could not read the PDF (${(err as Error)?.message}) - trying the older readers.`);
    }

    // 2) the file as uploaded, with the older readers bundled in pdf-parse
    try {
      return await this.readPdf(buffer);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`PDF could not be read as-is (${(err as Error)?.message}) - trying to repair it.`);
    }

    // 2) Many PDFs (some "Print to PDF" / scanner / export tools) have a damaged cross-reference table
    // ("bad XRef entry"). Viewers silently rebuild it; pdf.js here can't - but pdf-lib reads the objects
    // directly, so loading and re-saving the file produces a clean copy that can then be read.
    try {
      const repaired = await this.repairPdf(buffer);
      try {
        return await this.readPdfModern(repaired);
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        return await this.readPdf(repaired);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.error(`Could not read the PDF, even after repair. Last error: ${(err as Error)?.message ?? err}`);
    }

    throw new BadRequestException(
      'We could not read this PDF (it may be password-protected, damaged or an unusual format). Try opening it and re-saving it with "Save as PDF", or upload a DOCX or TXT version.',
    );
  }

  /** Text of every page (up to MAX_PDF_PAGES) using the current pdf.js. */
  private async readPdfModern(buffer: Buffer): Promise<string> {
    const resolved = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
    const pdfjs = await dynamicImport(pathToFileURL(resolved).href);
    const task = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      useSystemFonts: true,
      isEvalSupported: false,
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await task.promise;
    try {
      const pages: string[] = [];
      for (let i = 1; i <= Math.min(doc.numPages, MAX_PDF_PAGES); i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        pages.push(content.items.map((item: any) => (item.str ?? '') + (item.hasEOL ? '\n' : ' ')).join('').trim());
      }
      const text = pages.join('\n\n').trim();
      if (!text) {
        throw new BadRequestException(
          'No readable text was found in this PDF - it may be a scan or an image. Please upload a text-based PDF, a DOCX, or a TXT file.',
        );
      }
      return text;
    } finally {
      await doc.destroy().catch(() => undefined);
    }
  }

  /** Tries each bundled pdf.js engine in turn; throws the last error if none can read the file. */
  private async readPdf(buffer: Buffer): Promise<string> {
    let lastError: unknown;
    for (const version of PDF_ENGINES) {
      try {
        const data = await pdfParse(buffer, version ? { version } : undefined);
        const text = String(data?.text ?? '');
        if (!text.trim()) {
          throw new BadRequestException(
            'No readable text was found in this PDF - it may be a scan or an image. Please upload a text-based PDF, a DOCX, or a TXT file.',
          );
        }
        return text;
      } catch (err) {
        if (err instanceof BadRequestException) throw err;
        lastError = err;
        this.logger.warn(
          `PDF read failed with pdf.js ${version ?? 'v1.10.100 (default)'}: ${(err as Error)?.message || (err as any)?.name || err}`,
        );
      }
    }
    throw lastError;
  }

  private async repairPdf(buffer: Buffer): Promise<Buffer> {
    const doc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    });
    return Buffer.from(await doc.save({ useObjectStreams: false }));
  }
}
