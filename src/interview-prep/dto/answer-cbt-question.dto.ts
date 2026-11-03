import { IsInt, Min } from 'class-validator';

export class AnswerCbtQuestionDto {
  @IsInt()
  @Min(0)
  questionIndex: number;

  @IsInt()
  @Min(0)
  selectedOptionIndex: number;
}
