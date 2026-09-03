import { IsUUID } from 'class-validator';

/**
 * Deliberately just `planId` — see the commercial plan's security
 * section: price/RAM/CPU/disk are never client input, they're read from
 * the plan row itself under `CapacityService.lockPlan`. The global
 * `ValidationPipe({ forbidNonWhitelisted: true })` in main.ts turns any
 * extra field (a `priceCents` a client tried to smuggle in) into a 422
 * before this DTO is even constructed.
 */
export class CreateSubscriptionDto {
  @IsUUID()
  planId!: string;
}
