import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const JOB_TYPES = [
  'FULL_TIME',
  'PART_TIME',
  'REMOTE',
  'FREELANCE',
  'ONLINE',
  'CONTRACT',
  'INTERNSHIP',
  'CUSTOM',
] as const;

export class SearchJobsDto {
  @IsOptional()
  @IsString()
  query?: string; // e.g. "senior backend engineer" - free text job type/title

  @IsOptional()
  @IsArray()
  @IsIn(JOB_TYPES, { each: true })
  jobTypes?: string[]; // e.g. ["REMOTE", "FREELANCE"]

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  resumeId?: string; // defaults to the user's primary resume

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number; // how many jobs you want the AI to find (default 10, max 50)

  // Restrict the search to exactly one real job-board source by its
  // JobSourceProvider name (e.g. "adzuna", "remotive") - used by the "Search
  // source" filter in the UI. Validated against the live provider list in
  // JobsService.search (not a fixed enum here), since that's the single
  // place that already knows every provider that exists. Omit for the
  // normal multi-source search.
  @IsOptional()
  @IsString()
  source?: string;
}
