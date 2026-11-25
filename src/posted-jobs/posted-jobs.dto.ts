import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import { JOB_TYPES } from '../entities';

const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
/** Create: a blank optional field is simply "not given". */
const blankToUndefined = ({ value }: { value: unknown }) => {
  const v = trim(value);
  return v === '' ? undefined : v;
};
/** Update: a blank optional field means "clear it" (null), while a missing field means "leave it alone". */
const blankToNull = ({ value }: { value: unknown }) => {
  const v = trim(value);
  return v === '' ? null : v;
};

const URL_OPTIONS = { protocols: ['http', 'https'], require_protocol: true };

export class CreatePostedJobDto {
  @Transform(({ value }) => trim(value)) @IsString() @MinLength(3) @MaxLength(150) title: string;

  @IsOptional() @Transform(blankToUndefined) @IsString() @MaxLength(150) company?: string;
  @IsOptional() @Transform(blankToUndefined) @IsString() @MaxLength(150) location?: string;

  @IsOptional() @IsIn(JOB_TYPES as unknown as string[]) jobType?: (typeof JOB_TYPES)[number];

  @Transform(({ value }) => trim(value)) @IsString() @MinLength(20, { message: 'Describe the job in at least 20 characters.' }) @MaxLength(10_000) description: string;

  /** At least one of applyUrl / applyEmail is required (checked in the service). */
  @IsOptional() @Transform(blankToUndefined) @IsUrl(URL_OPTIONS, { message: 'The apply link must start with http:// or https://' }) @MaxLength(2000) applyUrl?: string;
  @IsOptional() @Transform(blankToUndefined) @IsEmail({}, { message: 'Enter a valid apply email address.' }) @MaxLength(200) applyEmail?: string;

  @IsOptional() @Transform(blankToUndefined) @IsString() @MaxLength(100) salary?: string;
  @IsOptional() @IsBoolean() isRemote?: boolean;

  /** ISO date-time. Must be in the future and no more than 180 days away (checked in the service). */
  @IsISO8601() expiresAt: string;
}

export class UpdatePostedJobDto {
  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MinLength(3) @MaxLength(150) title?: string;

  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(150) company?: string | null;
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(150) location?: string | null;

  @IsOptional() @IsIn(JOB_TYPES as unknown as string[]) jobType?: (typeof JOB_TYPES)[number];

  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MinLength(20, { message: 'Describe the job in at least 20 characters.' }) @MaxLength(10_000) description?: string;

  @IsOptional() @Transform(blankToNull) @IsUrl(URL_OPTIONS, { message: 'The apply link must start with http:// or https://' }) @MaxLength(2000) applyUrl?: string | null;
  @IsOptional() @Transform(blankToNull) @IsEmail({}, { message: 'Enter a valid apply email address.' }) @MaxLength(200) applyEmail?: string | null;

  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(100) salary?: string | null;
  @IsOptional() @IsBoolean() isRemote?: boolean;

  @IsOptional() @IsISO8601() expiresAt?: string;
}

export class ListPostedJobsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(JOB_TYPES as unknown as string[]) jobType?: (typeof JOB_TYPES)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
