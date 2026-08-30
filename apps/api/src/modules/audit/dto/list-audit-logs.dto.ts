import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class ListAuditLogsDto {
  /** Matched as a prefix, so `auth.` returns every auth.* action. */
  @IsOptional()
  @IsString()
  @Length(1, 191)
  action?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  // `from`/`to` are what let Postgres prune partitions on this
  // range-partitioned table (see migration 0004_log_partitioning) rather
  // than scanning the whole audit trail.
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  // Required because the global pipe runs with enableImplicitConversion:
  // false — a query-string number is a string until @Type converts it.
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
