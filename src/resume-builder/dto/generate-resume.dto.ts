import { IsOptional, IsString, MinLength } from 'class-validator';

export class GenerateResumeDto {
  // Build from an existing uploaded resume's parsed profile.
  @IsOptional()
  @IsString()
  resumeId?: string;

  // Or build from scratch using freeform career details typed directly
  // (used when no resumeId is given).
  @IsOptional()
  @IsString()
  @MinLength(20, { message: 'Please provide a bit more detail (at least 20 characters).' })
  rawDetails?: string;

  // Optional role to tailor emphasis toward, e.g. "Senior Frontend Engineer".
  @IsOptional()
  @IsString()
  targetRole?: string;

  // Optional custom title for this generated resume; auto-generated if omitted.
  @IsOptional()
  @IsString()
  title?: string;
}
