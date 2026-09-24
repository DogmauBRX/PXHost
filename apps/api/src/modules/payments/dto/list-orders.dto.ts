import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

const ORDER_STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'refunded', 'expired'] as const;
const PAYMENT_METHODS = ['pix', 'boleto', 'card'] as const;

/** Admin listing filters — same shape `ListSubscriptionsDto` already established: free-text `q`, closed-set filters, offset/limit pagination. */
export class ListOrdersDto {
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: (typeof ORDER_STATUSES)[number];

  @IsOptional()
  @IsIn(PAYMENT_METHODS)
  paymentMethod?: (typeof PAYMENT_METHODS)[number];

  @IsOptional()
  @IsUUID()
  planId?: string;

  // Matches against the owning customer's email/username — same
  // citext, case-insensitive-at-the-DB-level posture ListSubscriptionsDto's
  // own comment already documents.
  @IsOptional()
  @IsString()
  @Length(1, 191)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
