import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { TICKET_STATUSES, TicketStatus } from '../entities/support-ticket.entity';

export class ContactDto {
  @IsString() @MinLength(2) @MaxLength(100) name: string;
  @IsEmail() @MaxLength(200) email: string;
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @IsString() @MinLength(10, { message: 'Please write at least a sentence so we can help.' }) @MaxLength(5000) message: string;
  // Honeypot: real visitors never see or fill this field; bots do.
  @IsOptional() @IsString() website?: string;
}

export class CreateTicketDto {
  @IsString() @MinLength(3) @MaxLength(200) subject: string;
  @IsString() @MinLength(5) @MaxLength(5000) message: string;
  @IsOptional() @IsIn(['HELPDESK', 'CHATBOT']) source?: 'HELPDESK' | 'CHATBOT';
}

export class ReplyDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}

export class SetStatusDto {
  @IsIn(TICKET_STATUSES as unknown as string[]) status: TicketStatus;
}

export class ListTicketsQueryDto {
  @IsOptional() @IsIn([...TICKET_STATUSES, 'ALL']) status?: TicketStatus | 'ALL';
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
