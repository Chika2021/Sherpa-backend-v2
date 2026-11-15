import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** The links can arrive as one pasted block of text or as a JSON array of links - both end up as text here. */
const toText = ({ value }: { value: unknown }) => (Array.isArray(value) ? value.join('\n') : value);

export const LOCAL_BOARD_LINK_MODES = ['replace', 'append', 'remove'] as const;
export type LocalBoardLinkMode = (typeof LOCAL_BOARD_LINK_MODES)[number];

export class ListLocalJobBoardsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class CreateLocalJobBoardDto {
  @IsString() @MinLength(2) @MaxLength(80) country: string;

  /** Every job link for the country, pasted as-is (one per line is typical) - or an array of links. */
  @Transform(toText) @IsString() @MaxLength(200_000) links: string;
}

export class UpdateLocalJobBoardDto {
  /** Rename the board's country. */
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) country?: string;

  @IsOptional() @Transform(toText) @IsString() @MaxLength(200_000) links?: string;

  /**
   *   replace (default)  the board becomes exactly the pasted links - paste the full list for the country.
   *   append             add the pasted links to the ones already there.
   *   remove             take the pasted links off the board.
   */
  @IsOptional() @IsIn(LOCAL_BOARD_LINK_MODES as unknown as string[]) mode?: LocalBoardLinkMode;
}
