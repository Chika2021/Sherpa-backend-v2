import { IsBoolean, IsOptional } from 'class-validator';

export class SubmitAssistedDto {
  // Submit even though some required-looking fields are still empty (the
  // "required" detection is heuristic - the site's own validation has the
  // final say).
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
