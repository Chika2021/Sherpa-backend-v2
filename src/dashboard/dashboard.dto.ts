import { IsString, MaxLength, MinLength } from 'class-validator';

/** A bug report sent from the tester dashboard. It lands in the helpdesk as a ticket the admins can read. */
export class CreateBugReportDto {
  @IsString() @MinLength(3) @MaxLength(150) title: string;
  @IsString() @MinLength(5) @MaxLength(5000) details: string;
}
