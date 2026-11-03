import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { JOB_TYPES } from '../../jobs/dto/search-jobs.dto';

export class StartAutoApplyDto {
  // How many jobs you want the AI to find and apply to on your behalf, e.g. 10
  @IsInt()
  @Min(1)
  @Max(100)
  count!: number;

  // Apply to exactly these jobs (e.g. the roles currently listed on the Jobs page) instead of searching for new ones.
  // When set, `query` / `jobTypes` / `location` are ignored and `count` is capped to the number of eligible jobs.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  jobIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  query?: string; // e.g. "remote react developer" - or leave blank to let AI infer from your resume

  @IsOptional()
  @IsArray()
  @IsIn(JOB_TYPES, { each: true })
  jobTypes?: string[]; // ["REMOTE", "ONLINE", "FREELANCE", ...]

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsOptional()
  @IsString()
  resumeId?: string; // defaults to primary resume

  // Only apply to jobs that can be applied for online (i.e. that have a web application link).
  // Defaults to true on the server when omitted.
  @IsOptional()
  @IsBoolean()
  onlineOnly?: boolean;
}