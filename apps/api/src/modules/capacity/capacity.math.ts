import { ConflictException } from '@nestjs/common';

/** `overallocatePct === UNLIMITED` means "no ceiling at all" — the sentinel every reserved/overallocate column already used before this module existed. */
export const UNLIMITED = -1;

/**
 * The ceiling every capacity check compares `used + requested` against.
 * Returns `null` for "no ceiling" — either genuinely unlimited
 * (`overallocatePct === -1`) or **unconfigured** (`total <= 0`). Treating
 * an unconfigured total as unlimited rather than as a ceiling of 0 is
 * deliberate: `Node.cpuTotalPercent` defaults to 0 and is unpopulated on
 * every node created before capacity Fase 2 — a naive `(0 - 0) * n = 0`
 * ceiling would reject every create on every existing node the instant a
 * CPU check is wired in. A dedicated DB CHECK constraint (Fase 2) makes
 * the dangerous combination — CPU accounting turned on with no total set
 * — impossible to persist in the first place; this is the second,
 * cheaper layer of the same defense.
 *
 * Floors exactly once. Before this function existed, `assertCapacity`
 * compared against the raw float ceiling but only floored it when
 * building the error MESSAGE — so the API's pass/fail decision and the
 * number shown to an admin could disagree by up to 1 unit. Every caller
 * (the message, a future capacity report, a future capacity meter) reads
 * this same already-floored value, so they can never diverge again.
 */
export function ceilingFor(total: number, reserved: number, overallocatePct: number): number | null {
  if (overallocatePct === UNLIMITED) return null;
  if (total <= 0) return null;
  return Math.floor((total - reserved) * (1 + overallocatePct / 100));
}

/**
 * The single capacity gate every resource-allocating write path shares
 * (server create, node-to-node transfer, and — once Fase 6 closes that
 * hole — plan apply). Moved here from `servers.service.ts` unchanged in
 * behavior: same `NO_CAPACITY:` prefix (asserted verbatim by
 * `test/servers.e2e-spec.ts:182,209` — never rename it), same
 * used+requested-over-ceiling comparison. `unit` is new and defaults to
 * `'MB'` so every existing call site's message text is byte-identical;
 * Fase 2's CPU check is the first caller to pass `'%'`.
 */
export function assertCapacity(label: string, used: number, requested: number, totalMb: number, reservedMb: number, overallocatePct: number, unit = 'MB'): void {
  const ceiling = ceilingFor(totalMb, reservedMb, overallocatePct);
  if (ceiling === null) return; // unlimited or unconfigured — never a ceiling of 0
  if (used + requested > ceiling) {
    throw new ConflictException(`NO_CAPACITY: node ${label} would be ${used + requested}${unit}, ceiling is ${ceiling}${unit}`);
  }
}

/**
 * Capacity plan Fase 4 — a distinct prefix from `NO_CAPACITY:` is load-
 * bearing, not cosmetic: Fase 5's scheduler retry loop must tell "this
 * node doesn't fit" (try another node) apart from "the plan is sold out
 * everywhere" (retrying a different node never helps) — see this
 * function's only two callers for the same reasoning applied on the
 * write side (`ServersService.create`, under the plan lock) and the
 * read side (`CapacityReportService`, for a future vagas display).
 * `maxSlots === null` is unlimited — the only plans that predate this
 * migration, and any plan an admin explicitly wants uncapped.
 */
export function assertSlots(occupied: number, maxSlots: number | null): void {
  if (maxSlots === null) return;
  if (occupied >= maxSlots) {
    throw new ConflictException(`NO_SLOTS: plan would be ${occupied + 1}, max is ${maxSlots}`);
  }
}

/** The subset of `Node` columns `assertNodeFits` needs — a `Pick<>` of the real Prisma type at every call site, never a hand-typed duplicate. */
export interface NodeCapacityInputs {
  memoryTotalMb: number;
  memoryReservedMb: number;
  memoryOverallocatePct: number;
  diskTotalMb: number;
  diskReservedMb: number;
  diskOverallocatePct: number;
  cpuTotalPercent: number;
  cpuReservedPercent: number;
  cpuOverallocatePct: number;
}

export interface NodeUsage {
  memoryMb: number;
  diskMb: number;
  cpuPercent: number;
}

export interface ResourceRequest {
  memoryMb: number;
  diskMb: number;
  cpuPercent: number;
}

/**
 * Pure by design — takes already-fetched `node`/`usage`, never touches the
 * database itself, so it needs no `tx` and is unit-testable with plain
 * fixtures (mirrors `deriveHealthStatus`'s and `admin-permissions.ts`'s
 * posture: DB access stays in the injectable service, decisions stay in
 * plain functions). The caller is responsible for fetching `usage` under
 * the node's advisory lock — see `CapacityService.usageForNode`.
 *
 * Memory first, then disk, then CPU — deliberate order, so a request that
 * fails more than one dimension reports the most useful one (memory is
 * the dimension that's actually configured/enforced on every node today;
 * CPU stays a silent no-op on any node an admin hasn't explicitly turned
 * accounting on for, via `ceilingFor`'s `total <= 0` ⇒ unlimited rule and
 * the `nodes_cpu_accounting_check` DB constraint that makes "accounting
 * on, total unset" impossible to persist in the first place).
 */
export function assertNodeFits(node: NodeCapacityInputs, usage: NodeUsage, request: ResourceRequest): void {
  assertCapacity('memory', usage.memoryMb, request.memoryMb, node.memoryTotalMb, node.memoryReservedMb, node.memoryOverallocatePct);
  assertCapacity('disk', usage.diskMb, request.diskMb, node.diskTotalMb, node.diskReservedMb, node.diskOverallocatePct);
  assertCapacity('cpu', usage.cpuPercent, request.cpuPercent, node.cpuTotalPercent, node.cpuReservedPercent, node.cpuOverallocatePct, '%');
}

/**
 * Non-throwing sibling of `assertNodeFits`, for the read-only capacity
 * API (dashboard "would this fit" preview, `POST /capacity/simulate`) —
 * those callers want a reason string per failing dimension, not an
 * exception, and must never take the node's advisory lock (a preview
 * that blocked concurrent creates would be worse than useless). The
 * actual create/transfer paths keep calling `assertNodeFits` under lock;
 * this is deliberately a second, read-only caller of the same
 * `ceilingFor`, never a second implementation of the math.
 */
export function nodeFitReasons(node: NodeCapacityInputs, usage: NodeUsage, request: ResourceRequest): string[] {
  const reasons: string[] = [];
  const checks: { label: string; used: number; requested: number; total: number; reserved: number; overallocate: number; unit: string }[] = [
    { label: 'memory', used: usage.memoryMb, requested: request.memoryMb, total: node.memoryTotalMb, reserved: node.memoryReservedMb, overallocate: node.memoryOverallocatePct, unit: 'MB' },
    { label: 'disk', used: usage.diskMb, requested: request.diskMb, total: node.diskTotalMb, reserved: node.diskReservedMb, overallocate: node.diskOverallocatePct, unit: 'MB' },
    { label: 'cpu', used: usage.cpuPercent, requested: request.cpuPercent, total: node.cpuTotalPercent, reserved: node.cpuReservedPercent, overallocate: node.cpuOverallocatePct, unit: '%' },
  ];
  for (const c of checks) {
    const ceiling = ceilingFor(c.total, c.reserved, c.overallocate);
    if (ceiling === null) continue;
    if (c.used + c.requested > ceiling) {
      reasons.push(`${c.label}: would be ${c.used + c.requested}${c.unit}, ceiling is ${ceiling}${c.unit}`);
    }
  }
  return reasons;
}

export type CapacityStatus = 'normal' | 'warning' | 'high' | 'critical';

/** Per-node-configurable alert levels (`nodes.capacity_warn_pct` etc, defaults 70/85/95 — see schema.prisma) — the 4 levels the capacity dashboard's visual indicators use. */
export interface CapacityThresholds {
  warnPct: number;
  highPct: number;
  criticalPct: number;
}

/** Matches every existing node row's column defaults — the value every caller that hasn't fetched a specific node's thresholds should fall back to. */
export const DEFAULT_CAPACITY_THRESHOLDS: CapacityThresholds = { warnPct: 70, highPct: 85, criticalPct: 95 };

/**
 * Display-only usage categorization for the capacity dashboard's visual
 * indicators — thresholds are per-node configurable columns now (not a
 * hardcoded heuristic), but still purely derived at read time, never
 * stored, exactly like `deriveHealthStatus`. `usedPct` is used/ceiling,
 * already clamped by the caller if ceiling is unlimited.
 */
export function capacityStatus(usedPct: number, thresholds: CapacityThresholds = DEFAULT_CAPACITY_THRESHOLDS): CapacityStatus {
  if (usedPct >= thresholds.criticalPct) return 'critical';
  if (usedPct >= thresholds.highPct) return 'high';
  if (usedPct >= thresholds.warnPct) return 'warning';
  return 'normal';
}

// ─────────────────────── Automatic capacity derivation ───────────────────────

/** `Node.capacityMode` — 'manual' (default, every existing row) keeps the DECLARED columns as the ceiling; 'auto' derives them from agent telemetry. See `resolveNodeCapacity`'s own doc comment. */
export type CapacityMode = 'manual' | 'auto';

/** 'unconfigured' is distinct from both — 'auto' mode with no telemetry ever received for this dimension. Never falls back to "unlimited" (see `resolveNodeCapacity`'s doc comment on why that would be dangerous). */
export type CapacityProvenance = 'auto' | 'manual' | 'unconfigured';

/** One dimension's resolution detail — what the dashboard/node-edit UI needs to show the §25 chain (detected → margin → effective → reserved → available), never used by `ceilingFor` itself (that still only ever sees plain numbers). */
export interface ResolvedDimension {
  /** Raw agent telemetry, for display — null if never reported (or mode is 'manual', where it's simply not consulted). */
  detected: number | null;
  /** The admin-declared column — the manual override value, always present (defaults to 0 like the column itself). */
  declared: number;
  /** What actually becomes `total` in `ceilingFor` — `declared` in manual mode, `detected` in auto mode (when present). */
  effectiveTotal: number;
  /** The safety-margin percent actually applied (0 outside auto mode). */
  safetyMarginPct: number;
  /** The existing admin reserve column, unchanged — always one part of `reserved`. */
  adminReserve: number;
  /** What actually becomes `reserved` in `ceilingFor` — `adminReserve` alone in manual mode; `round(detected * safetyMarginPct / 100) + adminReserve` in auto mode. */
  reserved: number;
  provenance: CapacityProvenance;
}

/** How stale agent telemetry may be before `nodeAcceptsNewServers` stops trusting it as an auto-mode ceiling — generous relative to the ~15s heartbeat cadence, so one or two missed ticks (network blip) never blocks a sale. */
export const TELEMETRY_STALE_MS = 5 * 60_000;

/** The subset of a `Node` row `resolveNodeCapacity` needs — declared capacity columns, the new auto-mode columns, and the three reported-telemetry fields that (only in auto mode) cross from "informational" into "enforced." */
export interface NodeCapacityConfig extends NodeCapacityInputs {
  capacityMode: string;
  memorySafetyMarginPct: number;
  diskSafetyMarginPct: number;
  cpuSafetyMarginPct: number;
  reportedMemoryLimitMb: number | null;
  reportedMemoryTotalMb: number | null;
  reportedDiskTotalMb: number | null;
  reportedCpuCount: number | null;
  reportedAt: Date | null;
}

function resolveDimension(mode: CapacityMode, declaredTotal: number, declaredReserved: number, safetyMarginPct: number, detected: number | null): ResolvedDimension {
  if (mode !== 'auto') {
    // Manual — byte-for-byte today's behavior: the declared columns ARE
    // the ceiling inputs, telemetry is never consulted.
    return { detected, declared: declaredTotal, effectiveTotal: declaredTotal, safetyMarginPct: 0, adminReserve: declaredReserved, reserved: declaredReserved, provenance: 'manual' };
  }
  if (detected == null) {
    // Auto mode, no telemetry for this dimension yet. Falls back to the
    // declared column as `effectiveTotal` so `ceilingFor` never sees a
    // bogus number — but `provenance: 'unconfigured'` is what
    // `nodeAcceptsNewServers` refuses to sell against (see its own doc
    // comment): this is display/bookkeeping, never a green light.
    return { detected, declared: declaredTotal, effectiveTotal: declaredTotal, safetyMarginPct, adminReserve: declaredReserved, reserved: declaredReserved, provenance: 'unconfigured' };
  }
  const marginAmount = Math.round((detected * safetyMarginPct) / 100);
  return {
    detected,
    declared: declaredTotal,
    effectiveTotal: detected,
    safetyMarginPct,
    adminReserve: declaredReserved,
    reserved: marginAmount + declaredReserved,
    provenance: 'auto',
  };
}

/**
 * The single place that decides auto vs. manual (capacity plan §25's
 * chain: detected → safety margin → effective → already-reserved →
 * available) and translates a `Node` row into the exact same
 * `NodeCapacityInputs` shape `ceilingFor`/`assertNodeFits`/
 * `nodeFitReasons`/`snapshotDimension`/the scheduler already consume —
 * none of those functions change. Every one of their real call sites
 * (`ServersService`, `TransfersService`, `PlansService`,
 * `NodeSchedulerService`, `CapacityReportService`) should call this
 * FIRST and pass its return value in, instead of the raw Prisma row.
 *
 * The safety margin is folded directly into `reserved` (see
 * `resolveDimension`) — a deliberate choice: it means `ceilingFor` and
 * everything built on it need no changes at all to support margins,
 * admin reserves, AND stack cleanly (margin + admin reserve, never one
 * replacing the other).
 *
 * CPU is resolved the same way as memory/disk, using the same
 * `vCPU = cpuLimitPercent / 100` conversion `deriveTelemetryDivergence`
 * already uses elsewhere — `reportedCpuCount` (whole cores) × 100.
 * Memory prefers `reportedMemoryLimitMb` (the node's own cgroup limit)
 * over `reportedMemoryTotalMb` (the Docker daemon's host-wide MemTotal,
 * which leaks the Proxmox HOST's full RAM into an LXC guest without
 * lxcfs) — falling back to the latter only when the former was never
 * reported (older agent, or genuinely unlimited cgroup).
 */
export function resolveNodeCapacity(node: NodeCapacityConfig): NodeCapacityInputs & {
  memory: ResolvedDimension;
  disk: ResolvedDimension;
  cpu: ResolvedDimension;
  telemetryStale: boolean;
} {
  const mode: CapacityMode = node.capacityMode === 'auto' ? 'auto' : 'manual';

  const memory = resolveDimension(mode, node.memoryTotalMb, node.memoryReservedMb, node.memorySafetyMarginPct, node.reportedMemoryLimitMb ?? node.reportedMemoryTotalMb);
  const disk = resolveDimension(mode, node.diskTotalMb, node.diskReservedMb, node.diskSafetyMarginPct, node.reportedDiskTotalMb);
  const cpu = resolveDimension(mode, node.cpuTotalPercent, node.cpuReservedPercent, node.cpuSafetyMarginPct, node.reportedCpuCount != null ? node.reportedCpuCount * 100 : null);

  const telemetryStale = mode === 'auto' && (node.reportedAt == null || Date.now() - node.reportedAt.getTime() > TELEMETRY_STALE_MS);

  return {
    memoryTotalMb: memory.effectiveTotal,
    memoryReservedMb: memory.reserved,
    memoryOverallocatePct: node.memoryOverallocatePct,
    diskTotalMb: disk.effectiveTotal,
    diskReservedMb: disk.reserved,
    diskOverallocatePct: node.diskOverallocatePct,
    cpuTotalPercent: cpu.effectiveTotal,
    cpuReservedPercent: cpu.reserved,
    cpuOverallocatePct: node.cpuOverallocatePct,
    memory,
    disk,
    cpu,
    telemetryStale,
  };
}

/** The subset `nodeAcceptsNewServers` needs beyond what `resolveNodeCapacity` already resolved. `health` is `deriveHealthStatus`'s output — computed by the caller (nodes.service.ts), never re-derived here, so `capacity.math.ts` stays free of any import beyond itself. */
export interface NodeAcceptanceInputs {
  capacityMode: string;
  maintenanceMode: boolean;
  health: string;
  memory: ResolvedDimension;
  disk: ResolvedDimension;
  telemetryStale: boolean;
}

/**
 * Whether this node may be offered to a NEW create/subscribe/schedule —
 * never gates anything about servers already running on it. Capacity
 * plan §18/§22's "conservative by default": manual mode keeps EXACTLY
 * today's single gate (`maintenanceMode` — see `ServersService
 * .createOnNode`'s own check, unchanged), so no node anyone hasn't
 * explicitly opted into auto mode can be newly refused by this feature.
 * Auto mode additionally refuses whenever the telemetry backing the
 * ceiling can't be trusted: offline/degraded health, a dimension that
 * has never reported (`'unconfigured'`), or telemetry older than
 * `TELEMETRY_STALE_MS` — "no telemetry, no sale" rather than falling
 * back to treating an unconfigured total as unlimited.
 */
export function nodeAcceptsNewServers(node: NodeAcceptanceInputs): { ok: boolean; reason?: string } {
  if (node.maintenanceMode) return { ok: false, reason: 'Node is in maintenance mode' };
  if (node.capacityMode !== 'auto') return { ok: true };
  if (node.health === 'offline' || node.health === 'degraded') {
    return { ok: false, reason: `Node is ${node.health} — automatic capacity requires a recent heartbeat` };
  }
  if (node.memory.provenance === 'unconfigured' || node.disk.provenance === 'unconfigured') {
    return { ok: false, reason: 'Node is in automatic capacity mode but has not reported hardware telemetry yet' };
  }
  if (node.telemetryStale) {
    return { ok: false, reason: 'Node capacity telemetry is stale' };
  }
  return { ok: true };
}

export interface PlanSlotsResult {
  /** null = unlimited — every dimension the plan actually consumes is either unlimited or accounting-off. */
  slots: number | null;
  limiting: 'memory' | 'disk' | 'cpu' | null;
}

/**
 * How many more servers of this plan fit on this node right now —
 * capacity plan §6/§11, always the MINIMUM across dimensions (§6's own
 * worked examples), reporting which one is limiting (§16). A dimension
 * the plan doesn't actually consume (`requested <= 0`) or that has no
 * ceiling (unlimited, or CPU accounting off) is never the limiting
 * factor. A plan bigger than the node's remaining headroom on some
 * dimension correctly floors to `0` for that dimension, not negative.
 */
export function slotsForPlanOnNode(node: NodeCapacityInputs, usage: NodeUsage, request: ResourceRequest): PlanSlotsResult {
  const dims: { label: 'memory' | 'disk' | 'cpu'; total: number; reserved: number; overallocate: number; used: number; requested: number }[] = [
    { label: 'memory', total: node.memoryTotalMb, reserved: node.memoryReservedMb, overallocate: node.memoryOverallocatePct, used: usage.memoryMb, requested: request.memoryMb },
    { label: 'disk', total: node.diskTotalMb, reserved: node.diskReservedMb, overallocate: node.diskOverallocatePct, used: usage.diskMb, requested: request.diskMb },
    { label: 'cpu', total: node.cpuTotalPercent, reserved: node.cpuReservedPercent, overallocate: node.cpuOverallocatePct, used: usage.cpuPercent, requested: request.cpuPercent },
  ];

  let best: { label: 'memory' | 'disk' | 'cpu'; slots: number } | null = null;
  for (const d of dims) {
    if (d.requested <= 0) continue;
    const ceiling = ceilingFor(d.total, d.reserved, d.overallocate);
    if (ceiling === null) continue;
    const remaining = Math.max(ceiling - d.used, 0);
    const slots = Math.floor(remaining / d.requested);
    if (best === null || slots < best.slots) best = { label: d.label, slots };
  }

  return best === null ? { slots: null, limiting: null } : { slots: best.slots, limiting: best.label };
}
