import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWorkshopDto {
  // Rebuild the workshop from scratch (wipes progress and supervisor chat). Without it an existing workshop is returned unchanged and nothing is charged.
  @IsOptional()
  @IsBoolean()
  restart?: boolean;
}

export class SubmitWorkshopStepDto {
  // What the checkpoint asked for: pasted code, program output, or a short written explanation.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1, { message: 'Please paste your work before submitting.' })
  @MaxLength(12000, { message: 'Please keep your submission under 12,000 characters.' })
  submission: string;
}

export class AskWorkshopMentorDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3, { message: 'Please type a question.' })
  @MaxLength(2000, { message: 'Please keep your question under 2000 characters.' })
  question: string;
}

export class ApplyInternshipDocumentDto {
  // Currency to pay in (defaults to the app's DEFAULT_CURRENCY).
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;
}
