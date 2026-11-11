import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateNested } from 'class-validator';

export class ChatTurnDto {
  @IsIn(['user', 'bot']) role: 'user' | 'bot';
  @IsString() @MaxLength(1500) text: string;
}

export class ChatMessageDto {
  @IsString() @MinLength(1) @MaxLength(600) message: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];
}
