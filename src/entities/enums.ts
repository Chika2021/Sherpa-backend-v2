export const JOB_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'REMOTE',
  'FREELANCE',
  'ONLINE',
  'CONTRACT',
  'INTERNSHIP',
  'CUSTOM',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const APPLICATION_STATUSES = [
  'PENDING',
  'GENERATING',
  'READY',
  // Assisted apply: the form has been filled in a server-side browser and is
  // waiting for the user to review it and press Submit themselves.
  'AWAITING_REVIEW',
  'SUBMITTING',
  'SUBMITTED',
  'MANUAL_REVIEW',
  'FAILED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const DOCUMENT_TYPES = ['RESUME', 'COVER_LETTER'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const AUTO_APPLY_STATUSES = [
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'COMPLETED_WITH_ERRORS',
  'CANCELLED',
] as const;
export type AutoApplyStatus = (typeof AUTO_APPLY_STATUSES)[number];
