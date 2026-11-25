import { IsOptional, IsString, MaxLength } from 'class-validator';

export class TrackPageViewDto {
  /** The route the user opened, e.g. "/dashboard/jobs/123". Query string and #hash are dropped. */
  @IsString()
  @MaxLength(400)
  path: string;

  /** Optional page title. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}
