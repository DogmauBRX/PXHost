import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { deriveHealthStatus } from '../nodes/nodes.service';
import { CapacityService, SLOT_HOLDING_SUBSCRIPTION_STATUSES } from './capacity.service';
import { capacityStatus, ceilingFor, nodeFitReasons } from './capacity.math';
import { SimulateCapacityDto } from './dto/simulate-capacity.dto';

// Same omit as NodesService — controlTokenEnc is ciphertext and never
// legitimate in an HTTP response, and this service reads full Node rows
// independently of NodesService, so it repeats the same guard rather
// than depending on the other service's query shape.
const OMIT_CONTROL_TOKEN = { controlTokenEnc: true } as const;

/** The subset of a `Node` row every method here actually needs — matches `capacity.math.ts`'s `NodeCapacityInputs` plus the display fields the dashboard adds on top. */
interface NodeRow {
  id: string;
  name: string;
  maintenanceMode: boolean;
  isPublic: boolean;
  lastHeartbeatAt: Date | null;
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

function snapshotDimension(total: number, reserved: number, overallocatePct: number, allocated: number) {
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
    status: capacityStatus(usedPct),
  };
}

type DimensionSnapshot = ReturnType<typeof snapshotDimension>;

export interface NodeCapacitySnapshot {
  id: string;
  name: string;
  healthStatus: string;
  maintenanceMode: boolean;
  isPublic: boolean;
  serverCount: number;
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
    return {
      id: node.id,
      name: node.name,
      healthStatus: deriveHealthStatus(node.lastHeartbeatAt),
      maintenanceMode: node.maintenanceMode,
      isPublic: node.isPublic,
      serverCount,
      memory: snapshotDimension(node.memoryTotalMb, node.memoryReservedMb, node.memoryOverallocatePct, usage.memoryMb),
      disk: snapshotDimension(node.diskTotalMb, node.diskReservedMb, node.diskOverallocatePct, usage.diskMb),
      cpu: {
        ...snapshotDimension(node.cpuTotalPercent, node.cpuReservedPercent, node.cpuOverallocatePct, usage.cpuPercent),
        // Mirrors the `nodes_cpu_accounting_check` DB constraint's own
        // condition — "0 total" IS "accounting off," not "0 available."
        accountingEnabled: node.cpuTotalPercent > 0,
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
   * Occupancy per plan. No `maxSlots`/`available` here — that column
   * doesn't exist until capacity Fase 4; this is occupancy alone
   * (servers currently on the plan), the building block Fase 4's real
   * vagas ratio will be computed against.
   */
  /**
   * Occupancy per plan — same two-source sum as
   * `CapacityService.occupiedSlots` (servers on the plan, plus
   * commercial-site subscriptions not yet attached to a server), just
   * batched with `groupBy` instead of `occupiedSlots`'s per-plan count,
   * since this method reports on EVERY plan at once. Duplicating the
   * counting rule here (rather than calling `occupiedSlots` in a loop)
   * is deliberate — the doc comment on that method explains exactly why
   * the two sources can never double-count, and that reasoning applies
   * identically whether you ask about one plan or all of them.
   */
  async planUsage() {
    return this.withAdmin(async (tx) => {
      const plans = await tx.plan.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
      const [serverCounts, subscriptionCounts] = await Promise.all([
        tx.server.groupBy({ by: ['planId'], where: { status: { not: 'deleting' } }, _count: { _all: true } }),
        tx.subscription.groupBy({
          by: ['planId'],
          where: { serverId: null, status: { in: [...SLOT_HOLDING_SUBSCRIPTION_STATUSES] } },
          _count: { _all: true },
        }),
      ]);
      const occupiedByPlan = new Map(serverCounts.map((c) => [c.planId, c._count._all]));
      for (const c of subscriptionCounts) {
        occupiedByPlan.set(c.planId, (occupiedByPlan.get(c.planId) ?? 0) + c._count._all);
      }
      return plans.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        isPublic: p.isPublic,
        memoryMb: p.memoryMb,
        diskMb: p.diskMb,
        cpuLimitPercent: p.cpuLimitPercent,
        occupied: occupiedByPlan.get(p.id) ?? 0,
      }));
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
          const usage = await this.capacity.usageForNode(tx, node.id);
          const reasons = nodeFitReasons(node, usage, request);
          return {
            nodeId: node.id,
            name: node.name,
            fits: reasons.length === 0,
            reasons,
            healthStatus: deriveHealthStatus(node.lastHeartbeatAt),
          };
        }),
      );

      return { planId: plan.id, planName: plan.name, request, results };
    });
  }
}
