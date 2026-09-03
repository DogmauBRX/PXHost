import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { SUBSCRIPTION_STATUSES } from '../subscription-status';

export class UpdateSubscriptionStatusDto {
  @IsIn(SUBSCRIPTION_STATUSES)
  status!: (typeof SUBSCRIPTION_STATUSES)[number];

  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
