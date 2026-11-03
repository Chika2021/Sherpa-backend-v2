import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsDefined, IsString, ValidateNested } from 'class-validator';

export class FieldAnswerDto {
  @IsString()
  fieldId: string;

  // string | boolean | string[] - checked in the service, since
  // class-validator has no single decorator for that union.
  @IsDefined()
  value: string | boolean | string[];
}

export class AnswerFieldsDto {
  @IsArray()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => FieldAnswerDto)
  answers: FieldAnswerDto[];
}
