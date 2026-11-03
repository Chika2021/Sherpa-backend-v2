import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * "I found a job, here's its application page." `jobId` is the job the AI
 * search surfaced (so we tailor the resume/cover letter to it); the link is
 * the form the user actually landed on, which is often deeper than the
 * listing URL the AI found. If there's no jobId the user is applying to
 * something the AI didn't find - we build a lightweight job from the page.
 */
export class PrepareFromLinkDto {
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: false })
  applyUrl: string;

  @IsOptional()
  @IsString()
  jobId?: string;

  @IsOptional()
  @IsString()
  resumeId?: string; // defaults to the primary resume

  // Only used when there is no jobId; otherwise taken from the job / page.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  jobTitle?: string;
}
