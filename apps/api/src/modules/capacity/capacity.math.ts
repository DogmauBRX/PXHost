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

/**
 * Display-only usage categorization for the capacity dashboard's visual
 * indicators (normal/atenção/crítico) — thresholds are a UI heuristic,
 * NOT a stored/configurable column (nothing in the approved plan scoped
 * per-node configurable thresholds; this can grow admin-configurable
 * inputs later without changing any stored data, since it's derived at
 * read time exactly like `deriveHealthStatus`). `usedPct` is
 * used/ceiling, already clamped by the caller if ceiling is unlimited.
 */
export function capacityStatus(usedPct: number): 'normal' | 'warning' | 'critical' {
  if (usedPct >= 95) return 'critical';
  if (usedPct >= 80) return 'warning';
  return 'normal';
}
