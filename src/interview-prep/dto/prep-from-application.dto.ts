import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class PrepFromApplicationDto {
  // How many interview questions to generate (defaults to 10).
  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(20)
  count?: number;

  // Skip the existing prep for this job and generate a fresh set of questions.
  @IsOptional()
  @IsBoolean()
  regenerate?: boolean;
}
