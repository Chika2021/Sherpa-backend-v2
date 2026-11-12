import type { Job } from '../entities/job.entity';

/**
 * Turns the job an application points at into the same inputs the Interview
 * Prep page asks for (title / description / requirements), so prepping from an
 * application uses the job information already on file instead of making the
 * user type it in again.
 *
 * It is deterministic on purpose: the same job always yields the same values, so
 * an existing prep for that job can be found again (see InterviewPrepService
 * .createFromApplication and ApplicationsService.listForUser) instead of
 * generating - and billing for - a duplicate every time the button is clicked.
 */
export interface JobPrepInput {
  jobTitle: string;
  jobDescription: string;
  jobRequirements?: string;
}

export function jobToPrepInput(job: Pick<Job, 'title' | 'company' | 'location' | 'description'>): JobPrepInput {
  const title = (job.title || '').trim() || 'the role';
  const company = (job.company || '').trim();
  const jobTitle = company ? `${title} at ${company}` : title;

  // The CreateInterviewPrepDto requires >= 20 characters of description. A
  // listing with no/short description still gets a usable one from what we do know.
  let jobDescription = (job.description || '').trim();
  if (jobDescription.length < 20) {
    const bits = [`${title}${company ? ` at ${company}` : ''}`];
    if (job.location?.trim()) bits.push(`Location: ${job.location.trim()}`);
    jobDescription = [jobDescription, ...bits].filter(Boolean).join('. ');
  }

  return { jobTitle, jobDescription };
}
