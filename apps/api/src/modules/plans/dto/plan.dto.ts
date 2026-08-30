import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

export class CreatePlanDto {
  @IsString()
  @Length(1, 191)
  name!: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/)
  @Length(1, 191)
  slug!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cpuLimitPercent?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  memoryMb!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  swapMb?: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  diskMb!: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  ioWeight?: number;

  @IsOptional()
  @IsBoolean()
  oomKillEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDatabases?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxBackups?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxAllocations?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxSchedules?: number;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @Length(1, 191)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  // Every resource field below is editable (architecture doc 2.1/9's
  // plan-apply: "editing a plan never silently resizes running
  // containers" implies editing a plan must be POSSIBLE in the first
  // place — this DTO previously only allowed name/description/isPublic,
  // making "apply this plan change to N servers" inapplicable to
  // anything that actually mattered). update() itself never touches a
  // running server; PlansService.applyToServers (a separate, explicit
  // action) is the only thing that does.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cpuLimitPercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  memoryMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  swapMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  diskMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  ioWeight?: number;

  @IsOptional()
  @IsBoolean()
  oomKillEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxDatabases?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxBackups?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxAllocations?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxSchedules?: number;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;
}
