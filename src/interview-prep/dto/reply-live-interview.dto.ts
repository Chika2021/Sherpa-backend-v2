import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

// Multipart/form fields. The recording itself arrives as the "audio" file and is
// handled separately via @UploadedFile(); send EITHER audio or `answer`.
export class ReplyLiveInterviewDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(4000, { message: 'Please keep your answer under 4000 characters.' })
  answer?: string;
}
