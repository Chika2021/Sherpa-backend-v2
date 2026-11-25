/**
 * Which database tables belong to which app feature, so the super admin sees "Resumes use 40 MB" instead of a list of
 * table names. A table that is not listed here (a new feature, a migrations table...) shows up under "Other" automatically,
 * so nothing is ever left out of the total. Add new tables to the right feature when you add them.
 */
export interface StorageFeature {
  key: string;
  label: string;
  description: string;
  tables: string[];
}

export const STORAGE_FEATURES: StorageFeature[] = [
  { key: 'accounts', label: 'Accounts', description: 'Every user account: profile, role, tokens, sign-in details.', tables: ['users'] },
  { key: 'resumes', label: 'Resumes and resume builder', description: 'Uploaded resumes (parsed) and resumes built with AI.', tables: ['resumes', 'generated_resumes'] },
  { key: 'jobs', label: 'Job search and listings', description: 'Jobs found, every search and its results, saved jobs, job sources and local job boards.', tables: ['jobs', 'job_searches', 'job_search_results', 'saved_jobs', 'job_source_settings', 'local_job_boards'] },
  { key: 'ai-training-jobs', label: 'AI training jobs', description: 'Jobs users saved from the AI training section.', tables: ['saved_ai_training_jobs'] },
  { key: 'applications', label: 'Applications and documents', description: 'Job applications, apply-by-email, the cover letters and resumes generated for them, saved site logins.', tables: ['applications', 'email_applications', 'generated_documents', 'site_credentials'] },
  { key: 'interview', label: 'Interview prep and Lora', description: 'Interview preparation and live mock interviews.', tables: ['interview_preps', 'live_interviews'] },
  { key: 'skills', label: 'Skills and internship', description: 'Skill tutorials, lessons and internship content.', tables: ['skill_tutorials'] },
  { key: 'posted-jobs', label: 'Member-posted jobs', description: 'Jobs members post themselves.', tables: ['posted_jobs'] },
  { key: 'consultations', label: 'Consultations', description: 'Paid virtual consultations, enrolments and sessions.', tables: ['consultations', 'consultation_enrollments', 'consultation_sessions'] },
  { key: 'payments', label: 'Payments and tokens', description: 'Payment records and the token ledger.', tables: ['payment_transactions', 'token_billing_ledger'] },
  { key: 'referrals', label: 'Referrals', description: 'Invites and referral rewards.', tables: ['referrals'] },
  { key: 'support', label: 'Helpdesk and support', description: 'Support tickets and their messages.', tables: ['support_tickets', 'support_messages'] },
  { key: 'notifications', label: 'Notifications', description: 'The notification bell.', tables: ['notifications'] },
  { key: 'monitoring', label: 'Monitoring and flags', description: 'Flagged accounts and warnings sent to users.', tables: ['account_flags', 'user_warnings'] },
  { key: 'user-activity', label: 'User activity', description: 'Every page a user opened, and login visits. Can be cleared from User activity.', tables: ['page_views', 'user_sessions'] },
  { key: 'storage-history', label: 'Storage history', description: 'The readings behind the growth chart on this page.', tables: ['storage_snapshots'] },
];

export const OTHER_FEATURE = { key: 'other', label: 'Other', description: 'Tables that are not assigned to a feature yet.' };

/** table name -> feature key */
export const TABLE_TO_FEATURE: Record<string, string> = Object.fromEntries(
  STORAGE_FEATURES.flatMap((f) => f.tables.map((t) => [t, f.key] as const)),
);
