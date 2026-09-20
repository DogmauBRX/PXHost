import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsIP, IsISO8601, IsNumber, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateIf, ValidateNested } from 'class-validator';

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

  // Deploy plan — see the Node.controlAddress schema comment. Loosely
  // validated (scheme + host[:port], IP or hostname both valid — a
  // WireGuard tunnel address has no TLD) rather than @IsUrl, which
  // rejects bare IPs by default.
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/[^\s/]+$/, { message: 'controlAddress must look like http(s)://host[:port]' })
  controlAddress?: string;

  // Public-exposure plan — see Node.tunnelIp's schema comment. Like
  // controlAddress, this is meant to be set once WireGuard is actually
  // wired up, which may be after the node row already exists.
  @IsOptional()
  @IsIP()
  tunnelIp?: string;

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

  // Placement policy — see Node.reservedForPlansAbovePriceCents's own
  // schema comment. Optional and nullable like controlAddress/tunnelIp:
  // meant to be set once WireGuard/hardware are in place, which may be
  // after the node row already exists.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reservedForPlansAbovePriceCents?: number;

  // Capacity plan (auto-derivation) — defaults to 'manual' (the column
  // default) when omitted, same as every node created before this
  // feature existed. An admin CAN create a node already in 'auto' mode;
  // the safety margins/alert thresholds stay at their column defaults
  // (10/10/10, 70/85/95) until adjusted via PATCH — see UpdateNodeDto.
  @IsOptional()
  @IsIn(['manual', 'auto'])
  capacityMode?: string;
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

  // A future heads-up ("entra em manutenção às 22h"), distinct from
  // `maintenanceMode` above — see the column's own schema.prisma doc
  // comment. `null` explicitly clears it (an admin cancelling a planned
  // window); `undefined` (the field simply absent) leaves it untouched,
  // same convention every other optional field on this DTO already
  // follows. `@ValidateIf` skips the ISO-8601 check only for that `null`
  // case — `@IsOptional()` alone would also skip it for `undefined`, but
  // NOT let `null` itself through as a valid value.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsISO8601()
  maintenanceScheduledAt?: string | null;

  // Deploy plan — see CreateNodeDto's own doc comment and the
  // Node.controlAddress schema comment. Unlike fqdn/scheme/daemonPort
  // (immutable after create — the browser's target must never shift
  // under an in-flight console/transfer link), the control-plane origin
  // is meant to be adjusted post-bootstrap (e.g. once WireGuard is wired
  // up for a node created before it existed), so it's updatable here.
  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\/[^\s/]+$/, { message: 'controlAddress must look like http(s)://host[:port]' })
  controlAddress?: string;

  // Public-exposure plan — same "adjustable post-bootstrap" posture as
  // controlAddress just above; see Node.tunnelIp's schema comment.
  @IsOptional()
  @IsIP()
  tunnelIp?: string;

  // Placement policy — see Node.reservedForPlansAbovePriceCents's own
  // schema comment. `null` explicitly clears the reservation (same
  // convention as maintenanceScheduledAt); `undefined` leaves it
  // untouched.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reservedForPlansAbovePriceCents?: number | null;

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

  // Capacity plan (auto-derivation) — see NodesService.update's own doc
  // comment for the override guard these interact with.
  @IsOptional()
  @IsIn(['manual', 'auto'])
  capacityMode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  memorySafetyMarginPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  diskSafetyMarginPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  cpuSafetyMarginPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  capacityWarnPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  capacityHighPct?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  capacityCriticalPct?: number;

  // §14's override guard: PATCHing a declared total/percent ABOVE what
  // the node has actually reported is refused with 409 unless this is
  // explicitly set — see NodesService.update. Never persisted itself,
  // just a one-shot confirmation flag for this single request.
  @IsOptional()
  @IsBoolean()
  acknowledgeOverride?: boolean;

  // Free-text audit trail for a manual capacity change (§23) — recorded
  // in the audit entry's metadata, never a column on `nodes` itself.
  @IsOptional()
  @IsString()
  @Length(1, 500)
  changeReason?: string;
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

  // The node's own cgroup memory limit — see schema.prisma's
  // reportedMemoryLimitMb doc comment for why it's distinct from
  // reportedMemoryTotalMb (the LXC/Proxmox host-vs-guest RAM problem
  // capacity plan (auto-derivation) exists to fix). Same optional/
  // best-effort contract as every other reported_* field here.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedMemoryLimitMb?: number;

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

  // Automatic hardware-capacity detection — deeper host telemetry than
  // the block above. Same optional/best-effort contract: an older agent
  // simply never sends these, and NodeBootstrapService.heartbeat only
  // writes a column when its field is present.
  @IsOptional()
  @IsString()
  reportedCpuModel?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedCpuSockets?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedCpuPhysicalCores?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  reportedCpuUsagePercent?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  reportedLoadAvg1?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedMemoryUsedMb?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  reportedMemoryAvailableMb?: number;

  @IsOptional()
  @IsString()
  reportedVirtualizationSystem?: string;

  @IsOptional()
  @IsString()
  reportedVirtualizationRole?: string;

  /**
   * Per-server power states this node currently holds — see
   * srv.Manager.States in the agent. Optional like every other field
   * here: an older agent binary simply omits it, and the panel then
   * leaves `servers.power_state` untouched rather than assuming
   * anything.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ServerPowerStateDto)
  servers?: ServerPowerStateDto[];
}

/**
 * The agent's own srv.State values. Constrained by `@IsIn` rather than
 * accepted as a free string: this writes straight into a column the
 * panel branches on (a version change's "must be offline" precondition,
 * the capacity report's offline count), so an unknown value from a
 * mismatched agent build must be rejected at the edge, not stored and
 * silently treated as "not offline" everywhere downstream.
 */
export const SERVER_POWER_STATES = ['offline', 'starting', 'running', 'stopping', 'crashed'] as const;

export class ServerPowerStateDto {
  @IsUUID()
  uuid!: string;

  @IsIn(SERVER_POWER_STATES as unknown as string[])
  state!: string;
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
