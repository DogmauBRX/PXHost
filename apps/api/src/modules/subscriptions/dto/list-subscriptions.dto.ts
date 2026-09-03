import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { SUBSCRIPTION_STATUSES } from '../subscription-status';

/** Admin listing filters — same shape as `ListUsersDto` (users/dto/list-users.dto.ts): free-text `q`, a closed-set filter, and offset/limit pagination. */
export class ListSubscriptionsDto {
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: (typeof SUBSCRIPTION_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  planId?: string;

  // Matches against the owning customer's email/username (citext,
  // case-insensitive at the DB level already — see UsersService.list's
  // own comment on why no `mode: 'insensitive'` is needed).
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
