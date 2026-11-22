import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  password: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  /** The code from a friend's invite link (/register?ref=CODE). Optional; an invalid code never blocks sign-up. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  referralCode?: string;
}
