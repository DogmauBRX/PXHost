import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Min, ValidateNested } from 'class-validator';

// Shared by CreatePlanDto and UpdatePlanDto — kept here once rather than
// duplicated, since both need the exact same validators and it's easy for
// the two copies to drift (already happened before this: nine Plan
// columns were reachable by neither DTO).
class PlanCommercialFields {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceCents?: number;

  @IsOptional()
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsIn(['monthly', 'quarterly', 'semiannual', 'annual'])
  billingPeriod?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  backupRetentionDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  // Advisory only — never enforced (see Plan model's doc comment). All six
  // nullable in the DB; sending `undefined` here just leaves the existing
  // value untouched on update, matching every other optional field.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recommendedPlayersMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recommendedPlayersMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recommendedModsMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recommendedModsMax?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recommendedPluginsMin?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  recommendedPluginsMax?: number;

  // Display-only: clients cannot create servers today, so nothing enforces
  // this against an actual creation flow.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxServers?: number;

  // Capacity plan Fase 4 — commercial stock. Undefined leaves the
  // existing value untouched (same convention as every other optional
  // field here); there is deliberately no way to send `null` through
  // this DTO to reset a capped plan back to unlimited — matches every
  // other nullable field's existing convention, and an admin who wants
  // that can always send a very large number instead.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  maxSlots?: number;

  // Commercial site — admin-picked highlight (see Plan.isFeatured's own
  // doc comment in schema.prisma: never algorithmic). Undefined leaves
  // the existing value untouched, same convention as every field above.
  @IsOptional()
  @IsBoolean()
  isFeatured?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 60)
  highlightLabel?: string;
}

export class CreatePlanDto extends PlanCommercialFields {
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

export class UpdatePlanDto extends PlanCommercialFields {
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

class PlanNodeEntryDto {
  @IsUUID()
  nodeId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  priority?: number;
}

/** Body of `PUT /api/admin/plans/:id/nodes` — the FULL replacement set, not a delta (see `PlansService.setAllowedNodes`'s doc comment). */
export class SetPlanNodesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PlanNodeEntryDto)
  nodes!: PlanNodeEntryDto[];
}
