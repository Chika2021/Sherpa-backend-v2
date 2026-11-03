import { IsInt, IsString, Min, MinLength } from 'class-validator';

export class SubmitLabAttemptDto {
  @IsInt()
  @Min(0)
  exerciseIndex: number;

  @IsString()
  @MinLength(1, { message: 'Please submit an attempt before grading.' })
  submission: string;
}
