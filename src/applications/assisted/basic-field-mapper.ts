import { SubmissionProfile } from '../adapters/application-submitter.interface';
import { FormField } from './form-field.types';

export interface BasicMapContext {
  profile: SubmissionProfile;
  /** Full text of the generated cover letter, for "paste your cover letter" boxes. */
  coverLetterText?: string;
  /** How many file inputs the form has - a lone upload box is assumed to be the resume. */
  fileCount: number;
  hasCoverLetterFile: boolean;
}

export type BasicMapResult =
  | { value: string; source: 'profile' | 'document' }
  | { file: 'resume' | 'coverLetter' }
  | null;

const TEXT_LIKE = new Set(['text', 'email', 'tel', 'url', 'search', undefined]);

function splitName(fullName?: string): { first?: string; last?: string } {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return {};
  return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(' ') : undefined };
}

/**
 * Handles the fields every application has (name, email, phone, links,
 * resume/cover-letter uploads) with plain rules - no AI call, no guessing, and
 * the same answer every time. Anything it doesn't recognise, or has no data
 * for, returns null and moves on to the AI stage / the user.
 */
export function mapBasicField(field: FormField, ctx: BasicMapContext): BasicMapResult {
  const label = field.label.toLowerCase();
  const hay = [field.label, field.name, field.placeholder, field.autocomplete].filter(Boolean).join(' ').toLowerCase();
  const p = ctx.profile;

  if (field.kind === 'file') {
    if (/cover/.test(hay)) return ctx.hasCoverLetterFile ? { file: 'coverLetter' } : null;
    if (/resume|\bcv\b|curriculum/.test(hay)) return { file: 'resume' };
    if (ctx.fileCount === 1) return { file: 'resume' };
    return null;
  }

  if (field.kind === 'textarea') {
    if (/cover.?letter/.test(hay) && ctx.coverLetterText) {
      return { value: ctx.coverLetterText, source: 'document' };
    }
    return null;
  }

  if (field.kind !== 'text' || !TEXT_LIKE.has(field.inputType)) return null;

  const { first, last } = splitName(p.fullName);
  const pick = (value: string | undefined): BasicMapResult => (value ? { value, source: 'profile' } : null);

  if (/(^|[\s_-])(first|given)[\s_-]*name|forename|given-name/.test(hay)) return pick(first);
  if (/(^|[\s_-])(last|family)[\s_-]*name|surname|family-name/.test(hay)) return pick(last);
  if (/(full|legal)[\s_-]*name|^(your |candidate |applicant )?name\b/.test(label) || field.autocomplete === 'name') {
    return pick(p.fullName);
  }
  if (field.inputType === 'email' || /e-?mail/.test(hay)) return pick(p.email);
  if (field.inputType === 'tel' || /phone|mobile|telephone|\bcell\b/.test(hay)) return pick(p.phone);
  if (/linkedin/.test(hay)) return pick(p.linkedinUrl);
  if (/portfolio|personal (web)?site|\bwebsite\b|web site/.test(hay)) return pick(p.portfolioUrl);
  if (/^(current )?(city|location)\b|where are you (located|based)|current location/.test(label)) {
    return pick(p.location);
  }
  return null;
}
