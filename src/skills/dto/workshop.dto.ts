import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { MAX_INTERNSHIP_MONTHS, MIN_INTERNSHIP_MONTHS } from '../internship-schedule';

/** How long the internship runs. Used when creating the workshop and by PUT /duration. */
export class InternshipDurationDto {
  // "self_paced" = keep the current open-ended internship; "timeframe" = a fixed number of months with daily check-ins.
  @IsIn(['self_paced', 'timeframe'], { message: 'durationMode must be "self_paced" or "timeframe".' })
  durationMode: 'self_paced' | 'timeframe';

  // Required for "timeframe": how many months the internship lasts.
  @ValidateIf((o) => o.durationMode === 'timeframe')
  @IsInt({ message: 'months must be a whole number.' })
  @Min(MIN_INTERNSHIP_MONTHS, { message: `Choose at least ${MIN_INTERNSHIP_MONTHS} month.` })
  @Max(MAX_INTERNSHIP_MONTHS, { message: `Choose at most ${MAX_INTERNSHIP_MONTHS} months.` })
  months?: number;

  // The learner's IANA time zone (e.g. "Africa/Lagos"); decides when one check-in day ends. Defaults to UTC.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class CreateWorkshopDto {
  // Rebuild the workshop from scratch (wipes progress and supervisor chat). Without it an existing workshop is returned unchanged and nothing is charged.
  @IsOptional()
  @IsBoolean()
  restart?: boolean;

  // Optionally pick the internship duration in the same call (only applied when the workshop is created or restarted).
  @IsOptional()
  @IsIn(['self_paced', 'timeframe'], { message: 'durationMode must be "self_paced" or "timeframe".' })
  durationMode?: 'self_paced' | 'timeframe';

  @ValidateIf((o) => o.durationMode === 'timeframe')
  @IsInt({ message: 'months must be a whole number.' })
  @Min(MIN_INTERNSHIP_MONTHS)
  @Max(MAX_INTERNSHIP_MONTHS)
  months?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class InternshipCheckInDto {
  // How many internship days to open in this check-in. 1 = just today's task; more = work ahead (several days in one day).
  @IsOptional()
  @IsInt({ message: 'days must be a whole number.' })
  @Min(1)
  @Max(366)
  days?: number;

  // Optional: refreshes the learner's time zone for the daily check-in.
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class SubmitWorkshopStepDto {
  // What the checkpoint asked for: pasted code, program output, or a short written explanation.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Please paste your work before submitting.' })
  @MaxLength(12000, { message: 'Please keep your submission under 12,000 characters.' })
  submission: string;
}

export class AskWorkshopMentorDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3, { message: 'Please type a question.' })
  @MaxLength(2000, { message: 'Please keep your question under 2000 characters.' })
  question: string;
}

export class ApplyInternshipDocumentDto {
  // Currency to pay in (defaults to the app's DEFAULT_CURRENCY).
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}
