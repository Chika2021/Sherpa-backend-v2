export * from './serializable.entity';
export * from './enums';
export * from './user.entity';
export * from './resume.entity';
export * from './generated-resume.entity';
export * from './job.entity';
export * from './job-search.entity';
export * from './job-search-result.entity';
export * from './saved-job.entity';
export * from './saved-ai-training-job.entity';
export * from './generated-document.entity';
export * from './application.entity';
export * from './email-application.entity';
export * from './payment-transaction.entity';
export * from './site-credential.entity';
export * from './interview-prep.entity';
export * from './live-interview.entity';
export * from './skill-tutorial.entity';
export * from './token-billing-ledger.entity';
export * from './job-source-settings.entity';
export * from './local-job-board.entity';
export * from './support-ticket.entity';
export * from './support-message.entity';
export * from './user-session.entity';
export * from './referral.entity';
export * from './posted-job.entity';
export * from './consultation.entity';
export * from './consultation-enrollment.entity';
export * from './consultation-session.entity';
export * from './notification.entity';
export * from './account-flag.entity';
export * from './user-warning.entity';

import { User } from './user.entity';
import { Resume } from './resume.entity';
import { GeneratedResume } from './generated-resume.entity';
import { Job } from './job.entity';
import { JobSearch } from './job-search.entity';
import { JobSearchResult } from './job-search-result.entity';
import { SavedJob } from './saved-job.entity';
import { SavedAiTrainingJob } from './saved-ai-training-job.entity';
import { GeneratedDocument } from './generated-document.entity';
import { Application } from './application.entity';
import { EmailApplication } from './email-application.entity';
import { PaymentTransaction } from './payment-transaction.entity';
import { SiteCredential } from './site-credential.entity';
import { InterviewPrep } from './interview-prep.entity';
import { LiveInterview } from './live-interview.entity';
import { SkillTutorial } from './skill-tutorial.entity';
import { TokenBillingLedger } from './token-billing-ledger.entity';
import { JobSourceSettings } from './job-source-settings.entity';
import { LocalJobBoard } from './local-job-board.entity';
import { SupportTicket } from './support-ticket.entity';
import { SupportMessage } from './support-message.entity';
import { UserSession } from './user-session.entity';
import { Referral } from './referral.entity';
import { Notification } from './notification.entity';
import { AccountFlag } from './account-flag.entity';
import { UserWarning } from './user-warning.entity';
import { PostedJob } from './posted-job.entity';
import { Consultation } from './consultation.entity';
import { ConsultationEnrollment } from './consultation-enrollment.entity';
import { ConsultationSession } from './consultation-session.entity';

/** Every entity, in one place - used by both the Nest connection and the TypeORM CLI data source. */
export const ALL_ENTITIES = [
  User,
  Resume,
  GeneratedResume,
  Job,
  JobSearch,
  JobSearchResult,
  SavedJob,
  SavedAiTrainingJob,
  GeneratedDocument,
  Application,
  EmailApplication,
  PaymentTransaction,
  SiteCredential,
  InterviewPrep,
  LiveInterview,
  SkillTutorial,
  TokenBillingLedger,
  JobSourceSettings,
  LocalJobBoard,
  SupportTicket,
  SupportMessage,
  UserSession,
  Referral,
  Notification,
  AccountFlag,
  UserWarning,
  PostedJob,
  Consultation,
  ConsultationEnrollment,
  ConsultationSession,
];
