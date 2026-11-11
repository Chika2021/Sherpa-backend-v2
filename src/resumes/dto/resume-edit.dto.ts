import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ResumeExperienceDto {
  @IsString() @MaxLength(200) title: string;
  @IsString() @MaxLength(200) company: string;
  @IsOptional() @IsString() @MaxLength(60) startDate?: string;
  @IsOptional() @IsString() @MaxLength(60) endDate?: string;
  @IsOptional() @IsString() @MaxLength(6000) description?: string;
}

export class ResumeEducationDto {
  @IsString() @MaxLength(200) school: string;
  @IsOptional() @IsString() @MaxLength(200) degree?: string;
  @IsOptional() @IsString() @MaxLength(200) field?: string;
  @IsOptional() @IsString() @MaxLength(60) year?: string;
}

/** Full structured resume content, as shown in the manual editor. Sent whole on every save. */
export class UpdateResumeProfileDto {
  @IsOptional() @IsString() @MaxLength(200) fullName?: string;
  @IsOptional() @IsString() @MaxLength(200) email?: string;
  @IsOptional() @IsString() @MaxLength(60) phone?: string;
  @IsOptional() @IsString() @MaxLength(200) location?: string;
  @IsOptional() @IsString() @MaxLength(300) headline?: string;
  @IsOptional() @IsString() @MaxLength(4000) summary?: string;

  @IsOptional() @IsNumber() yearsOfExperience?: number;

  @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) @MaxLength(100, { each: true })
  skills: string[];

  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ResumeExperienceDto)
  experience: ResumeExperienceDto[];

  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => ResumeEducationDto)
  education: ResumeEducationDto[];
}

/** "Tell the AI what to change" - plain-language instruction applied to the resume. */
export class AiEditResumeDto {
  @IsString()
  @MinLength(3, { message: 'Tell the AI what you want changed (at least 3 characters).' })
  @MaxLength(2000)
  instruction: string;
}
