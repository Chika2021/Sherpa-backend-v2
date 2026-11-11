import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * What to answer: either the application form copied from the page (the whole form or just some
 * fields) as `formText`, or a link to the form as `applyUrl`. Provide one; if both are given the
 * pasted text wins (the user has already shown us exactly what they want answered).
 */
export class GuidedAnswersDto {
  @IsOptional() @IsString() @MaxLength(30000) formText?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: false })
  applyUrl?: string;
}
