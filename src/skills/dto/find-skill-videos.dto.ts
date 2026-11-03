import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_VIDEOS_PER_REQUEST } from '../../ai/skill-video.types';

export class FindSkillVideosDto {
  // How many tutorial videos the AI should find for this course.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_VIDEOS_PER_REQUEST)
  count: number;
}
