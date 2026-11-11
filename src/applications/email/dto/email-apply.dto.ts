import { IsBoolean, IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Step 1 of "apply by email": the user types the job (title, description, requirements) and, if they
 * already know it, who to email. The app drafts the email and generates a tailored resume + cover letter.
 */
export class CreateEmailApplicationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  jobTitle: string;

  @IsString()
  @MinLength(20, { message: 'Paste the job description (at least a couple of sentences) so the documents can be tailored to it.' })
  @MaxLength(20000)
  jobDescription: string;

  @IsOptional()
  @IsString()
  @MaxLength(10000)
  requirements?: string;

  // Optional: the company is used in the greeting and the document titles when known.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  company?: string;

  // Where the application goes. Can be added later, before sending.
  @IsOptional()
  @IsEmail({}, { message: 'recipientEmail must be a valid email address.' })
  @MaxLength(254)
  recipientEmail?: string;

  // Hiring manager / recruiter name for the greeting, e.g. "Ms Okafor". Optional.
  @IsOptional()
  @IsString()
  @MaxLength(100)
  recipientName?: string;

  // Defaults to the user's primary resume.
  @IsOptional()
  @IsString()
  resumeId?: string;
}

/** Edit the draft before sending. Every field is optional. */
export class UpdateEmailApplicationDto {
  @IsOptional()
  @IsEmail({}, { message: 'recipientEmail must be a valid email address.' })
  @MaxLength(254)
  recipientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  subject?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(6000)
  body?: string;
}

/** Ask the AI to rewrite just the email, optionally steering it ("shorter", "more formal", ...). */
export class RegenerateEmailDto {
  @IsOptional()
  @IsString()
  @MaxLength(300)
  instructions?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  recipientName?: string;
}

/** Send the application. Any edit fields given here are saved first, so "edit + send" is one call. */
export class SendEmailApplicationDto extends UpdateEmailApplicationDto {
  // Hidden copy to the user's own account email, so they keep exactly what was sent. Default true.
  @IsOptional()
  @IsBoolean()
  sendCopyToMe?: boolean;

  // Required to send an application that was already sent once (guards against double-clicks / duplicates).
  @IsOptional()
  @IsBoolean()
  resend?: boolean;
}
