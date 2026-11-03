import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AI_TRAINING_CATEGORIES, AiTrainingCategory } from '../ai-training.classifier';

// The saved copy is built from what the client sends back, so every field is
// validated and length-capped. applyUrl is restricted to http(s) because the
// UI renders it as a link - without that a `javascript:` URL could be saved.

export class SavedJobPayDto {
  @IsOptional() @IsNumber() min?: number;
  @IsOptional() @IsNumber() max?: number;
  @IsOptional() @IsString() @MaxLength(20) currency?: string;
  @IsOptional() @IsString() @MaxLength(1000) text?: string;
  @IsIn(['HOUR', 'UNKNOWN']) unit: 'HOUR' | 'UNKNOWN';
}

export class SaveAiTrainingJobDto {
  @IsString() @IsNotEmpty() @MaxLength(4000) id: string;
  @IsString() @IsNotEmpty() @MaxLength(200) source: string;
  @IsString() @IsNotEmpty() @MaxLength(500) title: string;
  @IsOptional() @IsString() @MaxLength(300) company?: string;
  @IsIn(AI_TRAINING_CATEGORIES as unknown as string[]) category: AiTrainingCategory;
  @IsOptional() @IsString() @MaxLength(300) location?: string;
  @IsBoolean() remote: boolean;
  @IsOptional() @IsString() @MaxLength(100) employmentType?: string;
  @IsOptional() @IsString() @MaxLength(2000) summary?: string;
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(4000) applyUrl: string;
  @IsOptional() @IsString() @MaxLength(64) postedAt?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => SavedJobPayDto)
  pay?: SavedJobPayDto;
}

/** POST /ai-training-jobs/saved - one job, several, or everything on screen ("save all"). */
export class SaveAiTrainingJobsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SaveAiTrainingJobDto)
  jobs: SaveAiTrainingJobDto[];
}

/** DELETE /ai-training-jobs/saved?id=... - a query param because job ids can contain `/` and `:`. */
export class DeleteSavedAiTrainingJobDto {
  @IsString() @IsNotEmpty() @MaxLength(4000) id: string;
}

/** A saved job as returned to the client: the AiTrainingJob shape plus when it was saved. */
export interface SavedAiTrainingJobView {
  id: string;
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
  savedAt: string;
}
