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
export * from './auto-apply-batch.entity';
export * from './payment-transaction.entity';
export * from './site-credential.entity';
export * from './interview-prep.entity';
export * from './live-interview.entity';
export * from './skill-tutorial.entity';
export * from './token-billing-ledger.entity';
export * from './job-source-settings.entity';
export * from './support-ticket.entity';
export * from './support-message.entity';

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
import { AutoApplyBatch } from './auto-apply-batch.entity';
import { PaymentTransaction } from './payment-transaction.entity';
import { SiteCredential } from './site-credential.entity';
import { InterviewPrep } from './interview-prep.entity';
import { LiveInterview } from './live-interview.entity';
import { SkillTutorial } from './skill-tutorial.entity';
import { TokenBillingLedger } from './token-billing-ledger.entity';
import { JobSourceSettings } from './job-source-settings.entity';
import { SupportTicket } from './support-ticket.entity';
import { SupportMessage } from './support-message.entity';

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
  AutoApplyBatch,
  PaymentTransaction,
  SiteCredential,
  InterviewPrep,
  LiveInterview,
  SkillTutorial,
  TokenBillingLedger,
  JobSourceSettings,
  SupportTicket,
  SupportMessage,
];
