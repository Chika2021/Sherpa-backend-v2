import { IsOptional, IsString } from 'class-validator';

export class CreateApplicationDto {
  @IsString()
  jobId: string;

  @IsOptional()
  @IsString()
  resumeId?: string; // defaults to primary resume
}
