import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Body for the "Ask AI" endpoints on interview-prep sessions and skill
 * courses. `focusIndex` is optional: on an interview prep it's the index of
 * the question the person is looking at, on a course it's the module index -
 * it lets the AI answer about that specific part instead of the whole
 * session/course.
 */
export class AskAiDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3, { message: 'Please type a question.' })
  @MaxLength(2000, { message: 'Please keep your question under 2000 characters.' })
  question: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(500)
  focusIndex?: number;
}
