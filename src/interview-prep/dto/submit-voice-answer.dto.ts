import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

// The audio itself arrives as a multipart file (field name "audio"), handled
// separately via @UploadedFile() - this DTO only covers the other form field.
export class SubmitVoiceAnswerDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  questionIndex: number;
}
