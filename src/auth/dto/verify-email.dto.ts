import { IsString, MaxLength, MinLength } from 'class-validator';

export class VerifyEmailDto {
  /** The raw token from the link in the verification email. */
  @IsString()
  @MinLength(16)
  @MaxLength(200)
  token: string;
}
