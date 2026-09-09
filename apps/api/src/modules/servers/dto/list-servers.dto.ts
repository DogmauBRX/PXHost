import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export class ListServersDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  ownerId?: string;

  // @Type is not optional here: main.ts configures the global pipe with
  // `enableImplicitConversion: false`, so `?limit=50` arrives as the STRING
  // "50" and @IsInt() would reject it with a 422. Same pattern as
  // list-users.dto.ts.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
