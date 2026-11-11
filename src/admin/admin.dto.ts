import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { ASSIGNABLE_ROLES, ROLES } from '../common/roles';
import { TRANSACTION_STATUSES } from '../entities/payment-transaction.entity';
import type { AssignableRole, Role } from '../common/roles';

export class ListUsersQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(ROLES as unknown as string[]) role?: Role;
  @IsOptional() @IsIn(['active', 'suspended']) status?: 'active' | 'suspended';
  @IsOptional() @IsIn(['createdAt', 'lastLoginAt', 'email', 'tokens']) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ListPaymentsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @IsIn(TRANSACTION_STATUSES as unknown as string[]) status?: (typeof TRANSACTION_STATUSES)[number];
  @IsOptional() @IsIn(['TOKENS', 'INTERNSHIP_DOCUMENT']) purpose?: 'TOKENS' | 'INTERNSHIP_DOCUMENT';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** Create an account. SUPER_ADMIN is never an allowed role; what each caller may assign is checked in AdminService. */
export class CreateUserDto {
  @IsEmail() email: string;
  @IsString() @MinLength(8, { message: 'Password must be at least 8 characters' }) @MaxLength(128) password: string;
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsIn(ASSIGNABLE_ROLES as unknown as string[]) role?: AssignableRole;
  /** Optional starting balance, recorded in the token ledger. */
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100_000) tokens?: number;
}

/** Super admin edits a (non-super-admin) account. Every field is optional. */
export class UpdateUserDto {
  @IsOptional() @IsBoolean() suspended?: boolean;
  @IsOptional() @IsIn(ASSIGNABLE_ROLES as unknown as string[]) role?: AssignableRole;
  @IsOptional() @IsEmail() email?: string;
  /** Sets a new password for the account. */
  @IsOptional() @IsString() @MinLength(8, { message: 'Password must be at least 8 characters' }) @MaxLength(128) password?: string;
  @IsOptional() @IsString() @MaxLength(80) firstName?: string;
  @IsOptional() @IsString() @MaxLength(80) lastName?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) location?: string;
  @IsOptional() @IsString() @MaxLength(300) linkedinUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) portfolioUrl?: string;
}

export class GrantTokensDto {
  @Type(() => Number) @IsNumber() @Min(0.01) @Max(100_000) amount: number;
  @IsOptional() @IsString() @MaxLength(120) note?: string;
}
