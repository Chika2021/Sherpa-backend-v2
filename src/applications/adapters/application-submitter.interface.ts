export interface SubmissionDocuments {
  resumePath: string;
  coverLetterPath?: string;
}

export interface SubmissionProfile {
  fullName?: string;
  email?: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  portfolioUrl?: string;
}

export type SubmissionOutcome = 'SUBMITTED' | 'MANUAL_REVIEW' | 'FAILED';

export interface SubmissionResult {
  outcome: SubmissionOutcome;
  message: string;
  fieldsFilled?: string[];
  fieldsMissing?: string[];
  screenshotPath?: string;
}

export interface SiteCredentials {
  username: string;
  password: string;
  // Explicit login page, if the site's login form isn't just "whatever page
  // the apply URL sends you to when you're not signed in".
  loginUrl?: string;
  signupUrl?: string;
  autoSignupIfMissing: boolean;
}

/**
 * Contract for anything that can attempt to submit a job application on the
 * candidate's behalf. Implementations should be conservative: if they are not
 * confident they filled out the form correctly (required fields missing, a
 * login wall, a CAPTCHA, an unrecognized multi-step flow, etc.), they must
 * return MANUAL_REVIEW rather than guessing or submitting a broken/garbage
 * application. A human-in-the-loop fallback is a feature, not a bug - it's
 * what keeps auto-apply trustworthy instead of spammy.
 */
export interface ApplicationSubmitter {
  name: string;
  canHandle(applyUrl: string): boolean;
  submit(
    applyUrl: string,
    profile: SubmissionProfile,
    documents: SubmissionDocuments,
    // Present only when the caller found a stored SiteCredential whose
    // domain matches the apply URL's hostname - see
    // ApplicationsService.generateAndSubmit. Implementations that don't
    // support authenticated sites at all can simply ignore this parameter.
    credentials?: SiteCredentials | null,
  ): Promise<SubmissionResult>;
}
