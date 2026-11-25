import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { CONSULTATION_CATEGORIES } from '../entities';

const trim = (value: unknown) => (typeof value === 'string' ? value.trim() : value);
const blankToUndefined = ({ value }: { value: unknown }) => {
  const v = trim(value);
  return v === '' ? undefined : v;
};
/** Update: a blank means "clear it" (null); a missing field means "leave it alone". */
const blankToNull = ({ value }: { value: unknown }) => {
  const v = trim(value);
  return v === '' ? null : v;
};

/** Only a Google Meet address is accepted: https://meet.google.com/abc-defg-hij */
const MEET_LINK = /^https:\/\/meet\.google\.com\/[a-z0-9][a-z0-9-]*(\?[^\s]*)?$/i;
const MEET_MESSAGE = 'Paste a Google Meet link, like https://meet.google.com/abc-defg-hij';

const CATEGORIES = CONSULTATION_CATEGORIES as unknown as string[];

/** Cheapest and dearest a place may cost, in USD. Students pay it through the payment gateway (Paystack). */
export const CONSULTATION_MIN_PRICE_USD = 1;
export const CONSULTATION_MAX_PRICE_USD = 1500;

/** Most sessions one consultation can have (a multi-day seminar, a weekly course...). */
export const MAX_SESSIONS_PER_CONSULTATION = 30;

/** One meeting inside a consultation. */
export class ConsultationSessionDto {
  /** Send the id of an existing session to keep/edit it; leave it out for a new one. */
  @IsOptional() @IsUUID() id?: string;
  /** e.g. "Day 2 - Mock interviews". Blank = no title. */
  @IsOptional() @Transform(blankToNull) @IsString() @MaxLength(120) title?: string | null;
  @IsISO8601() startsAt: string;
  @IsISO8601() endsAt: string;
  /** Optional Google Meet link for just this session (otherwise the consultation's link is used). Blank removes it. */
  @IsOptional() @Transform(blankToNull) @Matches(MEET_LINK, { message: MEET_MESSAGE }) @MaxLength(300) meetLink?: string | null;
}

export class CreateConsultationDto {
  @Transform(({ value }) => trim(value)) @IsString() @MinLength(3) @MaxLength(150) title: string;

  @Transform(({ value }) => trim(value)) @IsString() @MinLength(20, { message: 'Describe the consultation in at least 20 characters.' }) @MaxLength(5000) description: string;

  @IsOptional() @IsIn(CATEGORIES) category?: (typeof CONSULTATION_CATEGORIES)[number];

  /** Price to enrol, in US dollars (up to 2 decimals). Paid through the payment gateway, not with tokens. */
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(CONSULTATION_MIN_PRICE_USD) @Max(CONSULTATION_MAX_PRICE_USD) priceUsd: number;

  /** Most students allowed. Leave out for no limit. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) capacity?: number;

  /**
   * The meetings, in any order (they are sorted): one for a single class, several for a seminar or course.
   * Leave out to use startsAt/endsAt as one single session.
   */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_SESSIONS_PER_CONSULTATION) @ValidateNested({ each: true }) @Type(() => ConsultationSessionDto) sessions?: ConsultationSessionDto[];

  /** Only used when `sessions` is left out (one single session). */
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;

  /** Optional at creation; the owner can add it later. Used by every session that has no link of its own. */
  @IsOptional() @Transform(blankToUndefined) @Matches(MEET_LINK, { message: MEET_MESSAGE }) @MaxLength(300) meetLink?: string;
}

export class UpdateConsultationDto {
  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MinLength(3) @MaxLength(150) title?: string;
  @IsOptional() @Transform(({ value }) => trim(value)) @IsString() @MinLength(20, { message: 'Describe the consultation in at least 20 characters.' }) @MaxLength(5000) description?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: (typeof CONSULTATION_CATEGORIES)[number];

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(CONSULTATION_MIN_PRICE_USD) @Max(CONSULTATION_MAX_PRICE_USD) priceUsd?: number;
  /** null (or blank) = remove the limit. */
  @IsOptional() @Transform(({ value }) => (value === '' ? null : value)) @Type(() => Number) @IsInt() @Min(1) @Max(1000) capacity?: number | null;

  /**
   * The full list of sessions after the edit. Send each existing session with its id. Once students have enrolled, no
   * session can be removed and a session that has already started cannot change; later ones can be rescheduled and more can be added.
   */
  @IsOptional() @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_SESSIONS_PER_CONSULTATION) @ValidateNested({ each: true }) @Type(() => ConsultationSessionDto) sessions?: ConsultationSessionDto[];

  /** Shortcut for a consultation with ONE session (use `sessions` when there are several). */
  @IsOptional() @IsISO8601() startsAt?: string;
  @IsOptional() @IsISO8601() endsAt?: string;

  /** Blank removes the link. */
  @IsOptional() @Transform(blankToNull) @Matches(MEET_LINK, { message: MEET_MESSAGE }) @MaxLength(300) meetLink?: string | null;
}

/** Body of POST /consultations/:id/enroll. Everything is optional. */
export class EnrollConsultationDto {
  /** Currency to pay in (defaults to DEFAULT_CURRENCY, usually USD). Must be one GET /payments/config lists. */
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
}

export class ListConsultationsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(CATEGORIES) category?: (typeof CONSULTATION_CATEGORIES)[number];
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
