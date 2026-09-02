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

  // Physical/commercial CPU capacity, in "percent of a core" — the same
  // unit as `cpuLimitPercent` on plans/servers (100 = 1 core). Optional
  // and defaults to 0 (accounting off) so a node created before capacity
  // Fase 2 behaves identically to one created after it without this
  // field set: `ceilingFor`'s `total <= 0` rule and the
  // `nodes_cpu_accounting_check` DB constraint both treat "0 total" as
  // "CPU isn't being enforced here," never as "0 CPU available."
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cpuTotalPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cpuReservedPercent?: number;

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
  @Min(0)
  cpuTotalPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cpuReservedPercent?: number;

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

  // Capacity plan Fase 7 — what the agent ACTUALLY reports about its
  // host. All optional: an agent binary older than this milestone simply
  // never sends these, and NodesService.heartbeat only writes a
  // reported_* column when its field is present (see that method's own
  // doc comment) — never zeroes it out for an old agent.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedMemoryTotalMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedCpuCount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedDiskTotalMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedDiskFreeMb?: number;

  @IsOptional()
  @IsString()
  reportedOs?: string;

  @IsOptional()
  @IsString()
  reportedKernel?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedContainersRunning?: number;
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
