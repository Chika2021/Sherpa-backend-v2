import { IsOptional, IsString, MaxLength } from 'class-validator';

export class MarkAppliedDto {
  // Anything the user wants to remember about this application.
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
