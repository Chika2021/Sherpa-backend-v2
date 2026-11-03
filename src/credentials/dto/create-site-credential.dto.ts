import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateSiteCredentialDto {
  // e.g. "boards.greenhouse.io" or "myworkdayjobs.com" - matched as a
  // hostname suffix against the job's apply URL.
  @IsString()
  @MinLength(2)
  domain: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsString()
  @MinLength(1)
  username: string;

  @IsString()
  @MinLength(1)
  password: string;

  // Optional - only needed if the login form isn't reachable by just
  // visiting the apply page itself.
  @IsOptional()
  @IsString()
  loginUrl?: string;

  // Optional - only used if autoSignupIfMissing is turned on.
  @IsOptional()
  @IsString()
  signupUrl?: string;

  @IsOptional()
  @IsBoolean()
  autoSignupIfMissing?: boolean;
}
