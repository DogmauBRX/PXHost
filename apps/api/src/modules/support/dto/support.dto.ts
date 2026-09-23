import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

const trimString = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const TICKET_CATEGORIES = ['technical', 'billing', 'account', 'other'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const TICKET_STATUSES = ['open', 'in_progress', 'waiting_customer', 'closed'] as const;

export class CreateSupportTicketDto {
  @Transform(trimString)
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  subject!: string;

  @IsIn(TICKET_CATEGORIES)
  category!: (typeof TICKET_CATEGORIES)[number];

  @IsIn(TICKET_PRIORITIES)
  priority!: (typeof TICKET_PRIORITIES)[number];

  @IsOptional()
  @IsUUID()
  serverId?: string;

  @Transform(trimString)
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message!: string;
}

export class AddSupportMessageDto {
  @Transform(trimString)
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message!: string;
}

export class UpdateSupportTicketDto {
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: (typeof TICKET_STATUSES)[number];

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: (typeof TICKET_PRIORITIES)[number];
}

export class ListAdminSupportTicketsDto {
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: (typeof TICKET_STATUSES)[number];

  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: (typeof TICKET_PRIORITIES)[number];

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MaxLength(120)
  q?: string;
}
