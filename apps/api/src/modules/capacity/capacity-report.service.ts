import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { CapacityService, SLOT_HOLDING_SUBSCRIPTION_STATUSES } from './capacity.service';
import {
  capacityStatus,
  ceilingFor,
  nodeAcceptsNewServers,
  nodeFitReasons,
  resolveNodeCapacity,
  slotsForPlanOnNode,
  type CapacityProvenance,
  type CapacityThresholds,
} from './capacity.math';
import { SimulateCapacityDto } from './dto/simulate-capacity.dto';

// Same omit as NodesService — controlTokenEnc is ciphertext and never
// legitimate in an HTTP response, and this service reads full Node rows
// independently of NodesService, so it repeats the same guard rather
// than depending on the other service's query shape.
const OMIT_CONTROL_TOKEN = { controlTokenEnc: true } as const;

/** The subset of a `Node` row every method here actually needs — matches `resolveNodeCapacity`'s `NodeCapacityConfig` plus the display fields the dashboard adds on top. */
interface NodeRow {
  id: string;
  name: string;
  maintenanceMode: boolean;
  isPublic: boolean;
  lastHeartbeatAt: Date | null;
  capacityMode: string;
  memoryTotalMb: number;
  memoryReservedMb: number;
  memoryOverallocatePct: number;
  memorySafetyMarginPct: number;
  diskTotalMb: number;
  diskReservedMb: number;
  diskOverallocatePct: number;
  diskSafetyMarginPct: number;
  cpuTotalPercent: number;
  cpuReservedPercent: number;
  cpuOverallocatePct: number;
  cpuSafetyMarginPct: number;
  capacityWarnPct: number;
  capacityHighPct: number;
  capacityCriticalPct: number;
  reportedMemoryLimitMb: number | null;
  reportedMemoryTotalMb: number | null;
  reportedDiskTotalMb: number | null;
  reportedCpuCount: number | null;
  reportedAt: Date | null;
}

function snapshotDimension(total: number, reserved: number, overallocatePct: number, allocated: number, thresholds: CapacityThresholds) {
  const ceiling = ceilingFor(total, reserved, overallocatePct);
  // `ceiling === null` covers both genuinely unlimited (-1) and
  // unconfigured (total <= 0) — a dashboard number can't render
  // "infinite," so it falls back to physical-minus-reserved as a
  // reportable floor. `commercialIsFloor` on the aggregate lets the UI
  // say "at least" instead of implying that floor is a hard ceiling.
  const commercial = ceiling ?? Math.max(total - reserved, 0);
  const available = ceiling === null ? null : Math.max(ceiling - allocated, 0);
  const usedPct = commercial > 0 ? Math.round((allocated / commercial) * 100) : 0;
  return {
    totalPhysical: total,
    reservedAmount: reserved,
    overallocatePct,
    ceiling, // null = unlimited, never a hard number to compare against
    commercial, // always a finite number — the ceiling, or the physical-minus-reserved floor when unlimited
    isUnlimited: ceiling === null,
    allocated,
    available,
    usedPct,
    status: capacityStatus(usedPct, thresholds),
  };
}

/** `snapshotDimension`'s ceiling/usage math, plus the §25 provenance chain (detected → margin → effective) `resolveNodeCapacity` already computed — never re-derived here. */
type DimensionSnapshot = ReturnType<typeof snapshotDimension> & {
  provenance: CapacityProvenance;
  detected: number | null;
  safetyMarginPct: number;
};

export interface NodeCapacitySnapshot {
  id: string;
  name: string;
  healthStatus: string;
  maintenanceMode: boolean;
  isPublic: boolean;
  serverCount: number;
  capacityMode: string;
  telemetryStale: boolean;
  acceptsNewServers: boolean;
  acceptsNewServersReason: string | null;
  memory: DimensionSnapshot;
  disk: DimensionSnapshot;
  cpu: DimensionSnapshot & { accountingEnabled: boolean };
}

/**
 * The read-only Tier 2 half of the capacity module (capacity plan Fase
 * 2) — mirrors `AuditQueryService` sitting next to `AuditService`: this
 * class never mutates anything, only ever opens its own `withRLS` and
 * calls `CapacityService`'s Tier 1 methods (`usageForNode`), exactly as
 * `capacity.service.ts`'s own doc comment describes for a future
 * reporting layer. Every query here is admin-only (route guarded by
 * `AdminGuard`), so `withRLS({ isAdmin: true })` is the correct context
 * throughout, same as `NodesService`.
 */
@Injectable()
export class CapacityReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capacity: CapacityService,
  ) {}

  private withAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.withRLS({ userId: null, isAdmin: true }, fn);
  }

  private async snapshotNode(tx: Prisma.TransactionClient, node: NodeRow): Promise<NodeCapacitySnapshot> {
    const usage = await this.capacity.usageForNode(tx, node.id);
    const serverCount = await tx.server.count({ where: { nodeId: node.id, status: { not: 'deleting' } } });
    const health = deriveHealthStatus(node.lastHeartbeatAt);
    const resolved = resolveNodeCapacity(node);
    const thresholds: CapacityThresholds = { warnPct: node.capacityWarnPct, highPct: node.capacityHighPct, criticalPct: node.capacityCriticalPct };
    const acceptance = nodeAcceptsNewServers({
      capacityMode: node.capacityMode,
      maintenanceMode: node.maintenanceMode,
      health,
      memory: resolved.memory,
      disk: resolved.disk,
      telemetryStale: resolved.telemetryStale,
    });

    return {
      id: node.id,
      name: node.name,
      healthStatus: health,
      maintenanceMode: node.maintenanceMode,
      isPublic: node.isPublic,
      serverCount,
      capacityMode: node.capacityMode,
      telemetryStale: resolved.telemetryStale,
      acceptsNewServers: acceptance.ok,
      acceptsNewServersReason: acceptance.reason ?? null,
      memory: { ...snapshotDimension(resolved.memoryTotalMb, resolved.memoryReservedMb, resolved.memoryOverallocatePct, usage.memoryMb, thresholds), provenance: resolved.memory.provenance, detected: resolved.memory.detected, safetyMarginPct: resolved.memory.safetyMarginPct },
      disk: { ...snapshotDimension(resolved.diskTotalMb, resolved.diskReservedMb, resolved.diskOverallocatePct, usage.diskMb, thresholds), provenance: resolved.disk.provenance, detected: resolved.disk.detected, safetyMarginPct: resolved.disk.safetyMarginPct },
      cpu: {
        ...snapshotDimension(resolved.cpuTotalPercent, resolved.cpuReservedPercent, resolved.cpuOverallocatePct, usage.cpuPercent, thresholds),
        provenance: resolved.cpu.provenance,
        detected: resolved.cpu.detected,
        safetyMarginPct: resolved.cpu.safetyMarginPct,
        // Mirrors the `nodes_cpu_accounting_check` DB constraint's own
        // condition — "0 total" IS "accounting off," not "0 available."
        // Uses the RESOLVED total (detected, in auto mode), same reason
        // resolveNodeCapacity exists at all — a node in auto mode with
        // CPU telemetry reporting a real core count has accounting on
        // even though its declared `cpuTotalPercent` column is 0.
        accountingEnabled: resolved.cpuTotalPercent > 0,
      },
    };
  }

  /**
   * Global infrastructure dashboard: node health counts, server lifecycle
   * counts, and physical/reserved/commercial/allocated/available for
   * each of memory/disk/cpu, both globally and per node.
   */
  async dashboard() {
    return this.withAdmin(async (tx) => {
      const nodes = await tx.node.findMany({ where: { deletedAt: null }, omit: OMIT_CONTROL_TOKEN, orderBy: { name: 'asc' } });
      const perNode = await Promise.all(nodes.map((n) => this.snapshotNode(tx, n)));

      const nodesOnline = perNode.filter((n) => n.healthStatus === 'online').length;
      const nodesOffline = perNode.filter((n) => n.healthStatus === 'offline' || n.healthStatus === 'degraded').length;
      const nodesDisabled = perNode.filter((n) => n.maintenanceMode).length;

      // `deleting` is excluded from every count here — a server mid-hard-
      // delete no longer occupies capacity (CapacityService.usageForNode
      // applies the identical exclusion), so "total servers" should agree
      // with what the capacity numbers above already count.
      const statusRows = await tx.server.groupBy({ by: ['status'], _count: { _all: true } });
      const byStatus: Record<string, number> = {};
      for (const row of statusRows) byStatus[row.status] = row._count._all;
      const total = Object.entries(byStatus)
        .filter(([status]) => status !== 'deleting')
        .reduce((sum, [, count]) => sum + count, 0);
      // "Offline" at the server level is `power_state`, a different axis
      // from lifecycle `status` — a server can be `ready` (installed,
      // usable) with its container stopped. Only counted among `ready`
      // servers: a still-installing or suspended server has no
      // meaningful power state to report here.
      const offline = await tx.server.count({ where: { status: 'ready', powerState: 'offline' } });

      const sumDimension = (pick: (s: NodeCapacitySnapshot) => DimensionSnapshot) => {
        let physical = 0;
        let reserved = 0;
        let commercial = 0;
        let allocated = 0;
        let anyUnlimited = false;
        for (const n of perNode) {
          const d = pick(n);
          physical += d.totalPhysical;
          reserved += d.reservedAmount;
          commercial += d.commercial;
          allocated += d.allocated;
          if (d.isUnlimited) anyUnlimited = true;
        }
        return {
          physical,
          reserved,
          commercial,
          commercialIsFloor: anyUnlimited,
          allocated,
          available: Math.max(commercial - allocated, 0),
        };
      };

      return {
        nodes: { total: perNode.length, online: nodesOnline, offline: nodesOffline, disabled: nodesDisabled },
        servers: { total, active: byStatus['ready'] ?? 0, suspended: byStatus['suspended'] ?? 0, offline, byStatus },
        memory: sumDimension((n) => n.memory),
        disk: sumDimension((n) => n.disk),
        cpu: sumDimension((n) => n.cpu),
        perNode,
      };
    });
  }

  async nodeDetail(id: string): Promise<NodeCapacitySnapshot> {
    return this.withAdmin(async (tx) => {
      const node = await tx.node.findFirst({ where: { id, deletedAt: null }, omit: OMIT_CONTROL_TOKEN });
      if (!node) throw new NotFoundException('Node not found');
      return this.snapshotNode(tx, node);
    });
  }

  /**
   * Occupancy AND derived vagas per plan — occupancy is the same
   * two-source sum as `CapacityService.occupiedSlots` (servers on the
   * plan, plus commercial-site subscriptions not yet attached to a
   * server), batched with `groupBy` instead of `occupiedSlots`'s
   * per-plan count since this reports on EVERY plan at once (duplicating
   * the counting rule here rather than calling `occupiedSlots` in a loop
   * is deliberate — see that method's own doc comment for why the two
   * sources can never double-count, identically whether asked about one
   * plan or all of them).
   *
   * `derivedSlots` is the capacity plan's own §6/§11: the sum, across
   * every node the plan is eligible on (respecting `PlanNode`
   * restrictions, same as `NodeSchedulerService`), of
   * `slotsForPlanOnNode` — `null` if unlimited on every eligible node.
   * `effectiveSlots` is `min(derivedSlots, plan.maxSlots)` — `maxSlots`
   * stays an optional commercial CEILING on top of real capacity, never
   * a replacement for it (capacity plan decision (2)). `perNode` names
   * which node contributes how much and why (0 with a reason, same
   * shape `nodeFitReasons` already produces) — the §16 "capacity
   * estimada por plano" breakdown.
   */
  async planUsage() {
    return this.withAdmin(async (tx) => {
      const plans = await tx.plan.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
      const [serverCounts, subscriptionCounts, nodes, planNodeRows] = await Promise.all([
        tx.server.groupBy({ by: ['planId'], where: { status: { not: 'deleting' } }, _count: { _all: true } }),
        tx.subscription.groupBy({
          by: ['planId'],
          where: { serverId: null, status: { in: [...SLOT_HOLDING_SUBSCRIPTION_STATUSES] } },
          _count: { _all: true },
        }),
        tx.node.findMany({ where: { deletedAt: null }, omit: OMIT_CONTROL_TOKEN }),
        tx.planNode.findMany(),
      ]);
      const occupiedByPlan = new Map(serverCounts.map((c) => [c.planId, c._count._all]));
      for (const c of subscriptionCounts) {
        occupiedByPlan.set(c.planId, (occupiedByPlan.get(c.planId) ?? 0) + c._count._all);
      }

      const restrictionsByPlan = new Map<string, Set<string>>();
      for (const row of planNodeRows) {
        if (!restrictionsByPlan.has(row.planId)) restrictionsByPlan.set(row.planId, new Set());
        restrictionsByPlan.get(row.planId)!.add(row.nodeId);
      }

      const usageByNode = await this.capacity.usageForNodes(tx, nodes.map((n) => n.id));

      return plans.map((p) => {
        const restricted = restrictionsByPlan.get(p.id);
        const eligibleNodes = restricted ? nodes.filter((n) => restricted.has(n.id)) : nodes;
        const request = { memoryMb: p.memoryMb, diskMb: p.diskMb, cpuPercent: p.cpuLimitPercent };

        // Starts at 0 (not null) — a plan with no eligible/accepting
        // node anywhere has ZERO real capacity, never "unlimited". The
        // instant any eligible+accepting node reports unlimited (null),
        // the whole sum flips to null and stays there regardless of
        // what any other node contributes — one node with no ceiling is
        // enough to make the plan's total unlimited.
        let derivedSlots: number | null = 0;
        const perNode = eligibleNodes.map((node) => {
          const health = deriveHealthStatus(node.lastHeartbeatAt);
          const resolved = resolveNodeCapacity(node);
          const acceptance = nodeAcceptsNewServers({
            capacityMode: node.capacityMode,
            maintenanceMode: node.maintenanceMode,
            health,
            memory: resolved.memory,
            disk: resolved.disk,
            telemetryStale: resolved.telemetryStale,
          });
          if (!acceptance.ok) {
            return { nodeId: node.id, nodeName: node.name, slots: 0, limiting: null as 'memory' | 'disk' | 'cpu' | null, reason: acceptance.reason ?? null };
          }
          const usage = usageByNode.get(node.id) ?? { memoryMb: 0, diskMb: 0, cpuPercent: 0 };
          const { slots, limiting } = slotsForPlanOnNode(resolved, usage, request);
          if (slots === null) derivedSlots = null;
          else if (derivedSlots !== null) derivedSlots += slots;
          return { nodeId: node.id, nodeName: node.name, slots, limiting, reason: null };
        });

        const occupied = occupiedByPlan.get(p.id) ?? 0;
        const effectiveSlots = p.maxSlots == null ? derivedSlots : derivedSlots == null ? p.maxSlots : Math.min(derivedSlots, p.maxSlots);
        const remaining = effectiveSlots == null ? null : Math.max(effectiveSlots - occupied, 0);

        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          isPublic: p.isPublic,
          memoryMb: p.memoryMb,
          diskMb: p.diskMb,
          cpuLimitPercent: p.cpuLimitPercent,
          occupied,
          maxSlots: p.maxSlots,
          derivedSlots,
          effectiveSlots,
          remaining,
          perNode,
        };
      });
    });
  }

  /**
   * Per-node breakdown for ONE plan — the same `slotsForPlanOnNode`
   * computation `planUsage` does for every plan at once, scoped to a
   * single node for the node detail page's "Capacidade por plano" card
   * (§16). Still read-only, still never locks.
   */
  async nodePlans(nodeId: string) {
    return this.withAdmin(async (tx) => {
      const node = await tx.node.findFirst({ where: { id: nodeId, deletedAt: null }, omit: OMIT_CONTROL_TOKEN });
      if (!node) throw new NotFoundException('Node not found');

      const plans = await tx.plan.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
      const restrictions = await tx.planNode.findMany({ where: { nodeId } });
      const restrictedPlanIds = new Set(restrictions.map((r) => r.planId));
      const allPlanRestrictions = await tx.planNode.findMany({ select: { planId: true } });
      const plansWithAnyRestriction = new Set(allPlanRestrictions.map((r) => r.planId));

      const health = deriveHealthStatus(node.lastHeartbeatAt);
      const resolved = resolveNodeCapacity(node);
      const acceptance = nodeAcceptsNewServers({
        capacityMode: node.capacityMode,
        maintenanceMode: node.maintenanceMode,
        health,
        memory: resolved.memory,
        disk: resolved.disk,
        telemetryStale: resolved.telemetryStale,
      });
      const usage = await this.capacity.usageForNode(tx, nodeId);

      const results = plans
        // A plan restricted to OTHER nodes (has PlanNode rows, none for
        // this node) is simply not eligible here — same opt-in
        // restriction `isNodeAllowedForPlan` already enforces on write.
        .filter((p) => !plansWithAnyRestriction.has(p.id) || restrictedPlanIds.has(p.id))
        .map((p) => {
          if (!acceptance.ok) {
            return { planId: p.id, planName: p.name, slots: 0, limiting: null as 'memory' | 'disk' | 'cpu' | null, reason: acceptance.reason ?? null };
          }
          const { slots, limiting } = slotsForPlanOnNode(resolved, usage, { memoryMb: p.memoryMb, diskMb: p.diskMb, cpuPercent: p.cpuLimitPercent });
          return { planId: p.id, planName: p.name, slots, limiting, reason: null };
        });

      return { nodeId: node.id, nodeName: node.name, acceptsNewServers: acceptance.ok, results };
    });
  }

  /**
   * Dry-run only — see `nodeFitReasons`'s doc comment for why this never
   * takes a lock and is never the authority a real create trusts.
   */
  async simulate(dto: SimulateCapacityDto) {
    return this.withAdmin(async (tx) => {
      const plan = await tx.plan.findFirst({ where: { id: dto.planId, deletedAt: null } });
      if (!plan) throw new NotFoundException('Plan not found');
      const request = { memoryMb: plan.memoryMb, diskMb: plan.diskMb, cpuPercent: plan.cpuLimitPercent };

      const nodes = dto.nodeId
        ? await tx.node.findMany({ where: { id: dto.nodeId, deletedAt: null }, omit: OMIT_CONTROL_TOKEN })
        : await tx.node.findMany({ where: { deletedAt: null, maintenanceMode: false, isPublic: true }, omit: OMIT_CONTROL_TOKEN });
      if (dto.nodeId && nodes.length === 0) throw new NotFoundException('Node not found');

      const results = await Promise.all(
        nodes.map(async (node) => {
          const health = deriveHealthStatus(node.lastHeartbeatAt);
          const resolved = resolveNodeCapacity(node);
          const acceptance = nodeAcceptsNewServers({
            capacityMode: node.capacityMode,
            maintenanceMode: node.maintenanceMode,
            health,
            memory: resolved.memory,
            disk: resolved.disk,
            telemetryStale: resolved.telemetryStale,
          });
          if (!acceptance.ok) {
            return { nodeId: node.id, name: node.name, fits: false, reasons: [acceptance.reason ?? 'Node unavailable'], healthStatus: health };
          }
          const usage = await this.capacity.usageForNode(tx, node.id);
          const reasons = nodeFitReasons(resolved, usage, request);
          return {
            nodeId: node.id,
            name: node.name,
            fits: reasons.length === 0,
            reasons,
            healthStatus: health,
          };
        }),
      );

      return { planId: plan.id, planName: plan.name, request, results };
    });
  }
}
