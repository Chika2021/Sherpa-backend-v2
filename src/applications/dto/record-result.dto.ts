import { IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The outcome of an application that was filled in and submitted by the Sherpa browser extension
 * (the browser, not this server, does the submitting - this just records what happened).
 */
export class RecordResultDto {
  @IsIn(['SUBMITTED', 'MANUAL_REVIEW', 'FAILED'])
  outcome: 'SUBMITTED' | 'MANUAL_REVIEW' | 'FAILED';

  @IsString()
  @MaxLength(2000)
  message: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fieldsFilled?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  fieldsMissing?: string[];
}
