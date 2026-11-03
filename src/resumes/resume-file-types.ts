import { extname } from 'path';

export type ResumeKind = 'pdf' | 'docx' | 'doc' | 'rtf' | 'txt';

export const SUPPORTED_RESUME_MESSAGE =
  'Unsupported resume file type. Please upload a PDF, DOCX, DOC, RTF, TXT or MD file.';

const BY_EXTENSION: Record<string, ResumeKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.doc': 'doc',
  '.rtf': 'rtf',
  '.txt': 'txt',
  '.md': 'txt',
};

const BY_MIME: Record<string, ResumeKind> = {
  'application/pdf': 'pdf',
  'application/x-pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/plain': 'txt',
  'text/markdown': 'txt',
};

/** Extension wins (MIME types from browsers are unreliable), MIME type is the fallback. */
export function detectResumeKind(fileName: string, mimeType?: string): ResumeKind | null {
  const ext = extname(fileName || '').toLowerCase();
  return BY_EXTENSION[ext] ?? BY_MIME[(mimeType || '').toLowerCase()] ?? null;
}

export function isSupportedResumeFile(fileName: string, mimeType?: string): boolean {
  return detectResumeKind(fileName, mimeType) !== null;
}
