import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

export class CancelSubscriptionDto {
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;

  /**
   * Asaas migration (payments plan §19): when true, the subscription
   * (and its server) keeps running until `currentPeriodEndsAt` —
   * billing-cycle finishes the cancellation once that date passes. The
   * provider-side subscription is cancelled immediately either way (no
   * further charge is ever generated), so nothing is owed regardless of
   * this flag; it only controls when THIS platform's own status/server
   * follow.
   */
  @IsOptional()
  @IsBoolean()
  atPeriodEnd?: boolean;
}
