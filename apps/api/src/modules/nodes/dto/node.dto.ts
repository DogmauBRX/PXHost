import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

export class CreateNodeDto {
  @IsUUID()
  locationId!: string;

  @IsString()
  @Length(1, 191)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @Matches(/^[a-z0-9.-]+$/i, { message: 'fqdn must be a valid hostname' })
  fqdn!: string;

  @IsOptional()
  @IsIn(['http', 'https'])
  scheme?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  daemonPort?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  sftpPort?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  memoryTotalMb!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  memoryReservedMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  memoryOverallocatePct?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  diskTotalMb!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  diskReservedMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  diskOverallocatePct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  cpuOverallocatePct?: number;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  uploadSizeMb?: number;
}

export class UpdateNodeDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsBoolean()
  maintenanceMode?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  memoryTotalMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  memoryReservedMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  memoryOverallocatePct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  diskTotalMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  diskReservedMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  diskOverallocatePct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  cpuOverallocatePct?: number;
}

export class BootstrapRequestDto {
  @IsString()
  token!: string;

  @IsString()
  hostname!: string;

  @IsOptional()
  @IsString()
  os?: string;

  @IsOptional()
  @IsString()
  kernel?: string;

  @IsOptional()
  @IsString()
  dockerVersion?: string;

  @IsOptional()
  @IsString()
  arch?: string;
}

export class HeartbeatDto {
  @IsOptional()
  @IsString()
  agentVersion?: string;

  @IsOptional()
  @IsString()
  dockerVersion?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  uptimeSeconds?: number;
}

export class CreateAllocationRangeDto {
  @IsString()
  ip!: string;

  @IsOptional()
  @IsString()
  ipAlias?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1024)
  @Max(65535)
  startPort!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1024)
  @Max(65535)
  endPort!: number;
}
