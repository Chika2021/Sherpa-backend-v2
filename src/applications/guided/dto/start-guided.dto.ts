import { IsOptional, IsString, IsUrl, MaxLength, ValidateIf } from 'class-validator';

/**
 * Starts a guided application. Every field is optional: the user can give as much or as
 * little of the job as they have, and the answers/documents are tailored to whatever is there.
 */
export class StartGuidedDto {
  // Start from a job that already exists in the app (e.g. one found by search). When given, the
  // manual details below are ignored - the job's own title/company/description are used.
  @IsOptional() @IsString() jobId?: string;

  @IsOptional() @IsString() @MaxLength(200) jobTitle?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(20000) jobDescription?: string;
  @IsOptional() @IsString() @MaxLength(10000) requirements?: string;

  // The link to the application form, if they already have it.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: false })
  applyUrl?: string;

  // The pasted application form, saved as a draft so the user can come back to it.
  @IsOptional() @IsString() @MaxLength(30000) formText?: string;

  @IsOptional() @IsString() resumeId?: string; // defaults to the primary resume
}

/** Same optional fields, for editing the job details after the application was started. */
export class UpdateGuidedDetailsDto {
  @IsOptional() @IsString() @MaxLength(200) jobTitle?: string;
  @IsOptional() @IsString() @MaxLength(200) company?: string;
  @IsOptional() @IsString() @MaxLength(20000) jobDescription?: string;
  @IsOptional() @IsString() @MaxLength(10000) requirements?: string;

  // "" clears the saved link, so the URL check only applies to a non-empty value.
  @IsOptional()
  @ValidateIf((o) => o.applyUrl !== '')
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: false })
  applyUrl?: string;

  // The pasted application form, saved as a draft ("" clears it).
  @IsOptional() @IsString() @MaxLength(30000) formText?: string;
}
