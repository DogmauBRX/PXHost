import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

export class CreateDatabaseHostDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsString()
  @Length(1, 255)
  host!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsString()
  @Length(1, 191)
  username!: string;

  @IsString()
  @Length(1, 512)
  password!: string;

  @IsOptional()
  @IsUUID()
  nodeId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDatabases?: number;
}

export class UpdateDatabaseHostDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDatabases?: number;
}
