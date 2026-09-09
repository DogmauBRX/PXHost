import { IsString, Length } from 'class-validator';

/** Reason is REQUIRED (not optional, unlike CancelSubscriptionDto's) — a refund moves real money back and must always be auditable with a stated cause, never a bare click. */
export class RefundOrderDto {
  @IsString()
  @Length(1, 500)
  reason!: string;
}
