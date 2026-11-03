import { ResumeProfile } from '../../ai/gemini.service';

export interface JobSourceCriteria {
  query?: string;
  jobTypes?: string[];
  location?: string;
  limit?: number;
}

// A listing older than this is treated as no longer actively recruiting and
// filtered out by every JobSourceProvider - job search should only ever
// surface postings that are actually current. 30 days is generous enough to
// not starve low-volume categories while still excluding stale reposts.
export const MAX_LISTING_AGE_DAYS = 30;

export interface RawJobListing {
  source: string;
  externalId?: string;
  title: string;
  company?: string;
  companyLogoUrl?: string;
  location?: string;
  jobType: string;
  description: string;
  applyUrl: string;
  salary?: string;
  // Structured salary, when the source exposes it numerically rather than
  // (or in addition to) the free-text `salary` string above. Populated on a
  // best-effort basis - most free public boards only give the text form.
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  isRemote?: boolean;
  // Normalized work-arrangement tags, e.g. ['4-day week'], ['9-day fortnight'],
  // ['full-time']. Distinct from `jobType` (this app's own FULL_TIME/PART_TIME/
  // etc enum) - this is a free-form list for schedule details that don't map
  // cleanly onto that enum, most relevant for 4dayweek.io-style sources.
  workSchedule?: string[];
  postedAt?: Date;
  raw?: any;
}

/**
 * Pluggable interface for real job-board data sources (Remotive, RemoteOK,
 * Adzuna, JSearch/RapidAPI, Greenhouse/Lever public job boards, etc).
 * Implement this and add it to JobsService's `sources` array to widen
 * coverage. These are the ONLY source of listings a search result can ever
 * contain - job search intentionally never fabricates or AI-suggests a
 * posting, so every `applyUrl` returned to a user is a real link to the
 * actual job site, and every listing has been filtered to postings from the
 * last MAX_LISTING_AGE_DAYS days.
 */
export interface JobSourceProvider {
  name: string;
  search(profile: ResumeProfile, criteria: JobSourceCriteria): Promise<RawJobListing[]>;
}
