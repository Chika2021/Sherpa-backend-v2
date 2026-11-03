import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Input for the "just tell us the job" flow: the user doesn't need to have
 * already created/browsed a Job record - they just type in the company name
 * and job description (requirements optional) and we generate a tailored
 * resume + cover letter for it in one shot.
 */
export class GenerateForJobDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  company: string;

  @IsString()
  @MinLength(1)
  jobDescription: string;

  // Optional extra requirements/qualifications text. Kept separate from
  // jobDescription so callers don't have to pre-format anything - we merge it
  // in ourselves before handing it to the AI.
  @IsOptional()
  @IsString()
  requirements?: string;

  // Optional - falls back to `<role> at <company>`-style default if omitted.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  jobTitle?: string;

  // Defaults to the user's primary resume.
  @IsOptional()
  @IsString()
  resumeId?: string;
}
