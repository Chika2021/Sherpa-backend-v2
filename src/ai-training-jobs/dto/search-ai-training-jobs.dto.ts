import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AI_TRAINING_CATEGORIES, AiTrainingCategory } from '../ai-training.classifier';

export class SearchAiTrainingJobsDto {
  /** Free text matched against title, company and description, e.g. "python", "medical", "spanish". */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsIn(AI_TRAINING_CATEGORIES as unknown as string[])
  category?: AiTrainingCategory;

  /** Only fully remote roles. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  remote?: boolean;

  /** Restrict to one source, e.g. "remotive" or "greenhouse:examplecorp". */
  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number; // how many roles the user wants back (default 20, max 100)

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export interface AiTrainingJob {
  id: string; // `${source}:${externalId}`
  source: string;
  title: string;
  company?: string;
  category: AiTrainingCategory;
  location?: string;
  remote: boolean;
  employmentType: string;
  summary: string;
  applyUrl: string;
  postedAt?: string;
  pay?: { min?: number; max?: number; currency?: string; text?: string; unit: 'HOUR' | 'UNKNOWN' };
}

export interface SourceAttempt {
  source: string;
  /** Matching AI-training roles this source contributed. */
  found: number;
  /** skipped = not configured / not needed; error = the source failed. */
  status: 'ok' | 'skipped' | 'error';
  note?: string;
}

export interface AiTrainingJobsResponse {
  /** Roles gathered so far (the search stops querying sources once it has enough). */
  total: number;
  /** True when asking for more (a larger offset) could return more roles. */
  hasMore: boolean;
  /** Which sources were tried, in order - shows when the search fell through to the next one. */
  attempts: SourceAttempt[];
  limit: number;
  offset: number;
  jobs: AiTrainingJob[];
  /** Sources that were queried, so the UI can show where results came from. */
  sources: string[];
}

/** Events streamed by GET /ai-training-jobs/stream (one JSON object per line). */
export type AiTrainingSearchEvent =
  | { type: 'start'; sources: string[] }
  | { type: 'trying'; source: string; step: number; of: number }
  | { type: 'attempt'; attempt: SourceAttempt; gathered: number }
  | { type: 'done'; result: AiTrainingJobsResponse };
