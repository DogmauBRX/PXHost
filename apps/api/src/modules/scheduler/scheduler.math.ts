import { ceilingFor, type NodeCapacityInputs, type NodeUsage, type ResourceRequest } from '../capacity/capacity.math';

/**
 * (ceiling − used − requested) / ceiling for one dimension, clamped to
 * `1` when the dimension is unlimited (no ceiling to divide by) and to
 * `-1` for the degenerate `ceiling === 0` case (reserved capped exactly
 * at total, overallocate 0) — a real number is always returned, never
 * NaN/Infinity, since this feeds directly into `Math.min` for `fit`.
 */
export function headroomFor(total: number, reserved: number, overallocatePct: number, used: number, requested: number): number {
  const ceiling = ceilingFor(total, reserved, overallocatePct);
  if (ceiling === null) return 1;
  if (ceiling <= 0) return -1;
  return (ceiling - used - requested) / ceiling;
}

/**
 * Worst-fit scoring (capacity plan Fase 5): the node with the MOST
 * relative headroom on its tightest dimension wins — deliberately not
 * bin-packing (see the plan's own reasoning: with exactly two
 * always-on Proxmox nodes, packing only pays off when you can power
 * machines down, which isn't this topology; spreading load also caps
 * the blast radius of one node's failure). `serverCount` is
 * intentionally NOT an input — 20 small servers is emptier than 8 big
 * ones if the small ones leave more headroom, and the whole point of
 * worst-fit is picking by real headroom, not container count.
 *
 * `priority` (from `PlanNode`, 0 if the plan has no restriction on this
 * node) nudges the ranking without ever overriding it: at most ±0.20 of
 * score, which is smaller than the swing a single meaningfully-emptier
 * node produces on `fit` (a value in roughly [-1, 1]). An `unknown`
 * health status (no telemetry — every dev/test node, always) is
 * penalized but not eliminated (`NodeSchedulerService` already refused
 * `offline`/`degraded` before this is ever called) — see this
 * function's own caller for why refusing `unknown` outright would break
 * every environment with no live agent.
 */
export function fitScore(node: NodeCapacityInputs, usage: NodeUsage, request: ResourceRequest, priority: number, healthUnknown: boolean): number {
  const memory = headroomFor(node.memoryTotalMb, node.memoryReservedMb, node.memoryOverallocatePct, usage.memoryMb, request.memoryMb);
  const disk = headroomFor(node.diskTotalMb, node.diskReservedMb, node.diskOverallocatePct, usage.diskMb, request.diskMb);
  const cpu = headroomFor(node.cpuTotalPercent, node.cpuReservedPercent, node.cpuOverallocatePct, usage.cpuPercent, request.cpuPercent);
  const fit = Math.min(memory, disk, cpu);
  return fit + 0.2 * (priority / 100) - (healthUnknown ? 0.5 : 0);
}

export interface RankableCandidate {
  nodeId: string;
  score: number;
  priority: number;
  memoryFreeMb: number;
}

/**
 * Highest score first; ties broken deterministically — priority, then
 * free RAM, then node id — so a test (or an admin staring at
 * `metadata.scheduler` six months later) can assert on the exact
 * winner, not "one of the tied nodes."
 */
export function rankCandidates<T extends RankableCandidate>(candidates: T[]): T[] {
  return [...candidates].sort(
    (a, b) => b.score - a.score || b.priority - a.priority || b.memoryFreeMb - a.memoryFreeMb || a.nodeId.localeCompare(b.nodeId),
  );
}
