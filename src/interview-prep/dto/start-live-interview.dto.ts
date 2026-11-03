import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class StartLiveInterviewDto {
  // One of GET /interview-prep/voices. Defaults to Lora's own voice.
  @IsOptional()
  @IsString()
  voice?: string;

  // How many main questions Lora asks (follow-ups are extra). Default 6.
  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(10)
  questionCount?: number;

  // If an interview for this prep is already in progress, the default is to
  // resume it. Pass true to abandon it and start a fresh one instead.
  @IsOptional()
  @IsBoolean()
  restart?: boolean;
}
