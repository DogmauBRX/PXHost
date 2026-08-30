import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ListUsersDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  q?: string;

  @IsOptional()
  @IsIn(['user', 'support', 'admin', 'root_admin'])
  role?: string;

  // @Type is not optional here: main.ts configures the global pipe with
  // `enableImplicitConversion: false`, so `?limit=50` arrives as the STRING
  // "50" and @IsInt() would reject it with a 422. Same pattern as
  // database-host.dto.ts.
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
