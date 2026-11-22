import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { FLAG_SEVERITIES, FLAG_STATUSES } from '../entities/account-flag.entity';

export class ListFlagsQueryDto {
  /** Default OPEN. ALL shows everything. */
  @IsOptional() @IsIn([...FLAG_STATUSES, 'ALL']) status?: (typeof FLAG_STATUSES)[number] | 'ALL';
  @IsOptional() @IsIn(FLAG_SEVERITIES as unknown as string[]) severity?: (typeof FLAG_SEVERITIES)[number];
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** The warning text the user receives, in the app and by email. */
export class WarnUserDto {
  @IsString() @MinLength(5, { message: 'Write a short warning (at least 5 characters).' }) @MaxLength(1000) message: string;
}

/** The reason is shown to the user when they try to sign in, so keep it factual. */
export class SuspendUserDto {
  @IsString() @MinLength(5, { message: 'Give a reason (at least 5 characters).' }) @MaxLength(300) reason: string;
}

export class ReviewNoteDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
