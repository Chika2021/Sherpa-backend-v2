import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateSkillTutorialDto {
  // The course/skill name the user typed, e.g. "React Hooks", "Public Speaking".
  @IsString()
  @MinLength(2)
  skillName: string;

  @IsOptional()
  @IsIn(['Beginner', 'Intermediate', 'Advanced'])
  level?: 'Beginner' | 'Intermediate' | 'Advanced';
}
