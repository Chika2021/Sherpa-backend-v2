import { IsBoolean, IsOptional } from 'class-validator';

// e.g. body: { "adzunaEnabled": true, "weAreDevelopersEnabled": false, "arcDevEnabled": true }
// All fields optional so the frontend can flip one switch at a time without
// having to resend the other two.
export class UpdateJobSourceSettingsDto {
  @IsOptional()
  @IsBoolean()
  adzunaEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  weAreDevelopersEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  arcDevEnabled?: boolean;
}
