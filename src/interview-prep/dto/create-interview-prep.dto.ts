import { IsInt, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';

export class CreateInterviewPrepDto {
  @IsString()
  @MinLength(2)
  jobTitle: string;

  @IsString()
  @MinLength(20, { message: 'Please provide a bit more detail (at least 20 characters).' })
  jobDescription: string;

  // Optional - if omitted, questions are generated from the title/description alone.
  @IsOptional()
  @IsString()
  jobRequirements?: string;

  // How many interview questions to generate.
  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(20)
  count?: number;
}
