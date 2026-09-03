import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma/prisma.service';
import { AgentClient } from '../nodes/agent-client.service';
import { AuditService } from '../audit/audit.service';
import { CapacityService } from '../capacity/capacity.service';
import { nodeFitReasons } from '../capacity/capacity.math';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';
import { PLAN_CLIENT_SELECT } from '../authorization/server-access.service';
import { PublicPlansService } from '../public/public-plans.service';

// The plan fields snapshotted onto every server at creation time
// (architecture doc 2.1: "Snapshot, not reference ... editing a plan
// never silently resizes running containers") — the exact set
// applyToServers compares and can push. maxAllocations isn't here: it's
// checked only at allocation-request time, never snapshotted onto the
// server row itself, so there's nothing on a server to drift from it.
const DRIFTABLE_FIELDS = ['cpuLimitPercent', 'memoryMb', 'swapMb', 'diskMb', 'ioWeight', 'oomKillEnabled', 'maxDatabases', 'maxBackups', 'maxSchedules'] as const;
type DriftableField = (typeof DRIFTABLE_FIELDS)[number];

// Of those, only these five actually reach the agent — the rest
// (oomKillEnabled: hardcoded false agent-side regardless, architecture
// doc 4.6; maxDatabases/maxBackups/maxSchedules: pure panel-side quota
// checks) have no live container state to push.
const LIVE_RESOURCE_FIELDS: DriftableField[] = ['cpuLimitPercent', 'memoryMb', 'swapMb', 'diskMb', 'ioWeight'];

// Ranges that must be min <= max when both sides are present. Backstopped
// by CHECK constraints in migration 0007 — this exists only so a bad
// range comes back as a readable 400 instead of a raw Postgres constraint
// error.
const RANGE_PAIRS = [
  ['recommendedPlayersMin', 'recommendedPlayersMax'],
  ['recommendedModsMin', 'recommendedModsMax'],
  ['recommendedPluginsMin', 'recommendedPluginsMax'],
] as const;

function assertRecommendationRanges(input: object): void {
  const p = input as Record<string, number | null | undefined>;
  for (const [minKey, maxKey] of RANGE_PAIRS) {
    const min = p[minKey];
    const max = p[maxKey];
    if (min != null && max != null && min > max) {
      throw new BadRequestException(`${minKey} must be <= ${maxKey}`);
    }
  }
}

export interface PlanDriftEntry {
  serverId: string;
  serverName: string;
  nodeId: string;
  changes: { field: DriftableField; from: number | boolean; to: number | boolean }[];
}

/** Per-node capacity preview entry — the "wall" `GET /:id/drift` shows before the click (capacity plan Fase 6). */
export interface PlanCapacityPreviewEntry {
  nodeId: string;
  nodeName: string;
  fits: boolean;
  reasons: string[];
  affectedServerIds: string[];
}

/** Internal, richer drift row — carries the raw current values `computeNodeDeltas` needs, not just the field-level diff `PlanDriftEntry` exposes publicly. */
interface DriftRow {
  id: string;
  name: string;
  nodeId: string;
  memoryMb: number;
  diskMb: number;
  cpuLimitPercent: number;
  changes: { field: DriftableField; from: number | boolean; to: number | boolean }[];
}

/**
 * The correct math for "would applying this plan push a node over
 * capacity" (capacity plan Fase 6, achado #1): a PER-NODE delta, not
 * `used + plan.memoryMb`. Each drifted server on the node already
 * contributes its OLD value to `CapacityService.usageForNode`'s current
 * usage — summing `plan[dim] − server[dim]` across just that node's
 * drifted servers gives exactly the node's total post-apply usage once
 * added to today's usage, without double-counting the servers being
 * resized. A shrinking plan produces a negative delta, which trivially
 * passes any capacity check — exactly the "encolher plano é permitido"
 * rule.
 */
function computeNodeDeltas(
  plan: { memoryMb: number; diskMb: number; cpuLimitPercent: number },
  rows: DriftRow[],
): Map<string, { memoryMb: number; diskMb: number; cpuPercent: number }> {
  const deltas = new Map<string, { memoryMb: number; diskMb: number; cpuPercent: number }>();
  for (const row of rows) {
    const delta = deltas.get(row.nodeId) ?? { memoryMb: 0, diskMb: 0, cpuPercent: 0 };
    delta.memoryMb += plan.memoryMb - row.memoryMb;
    delta.diskMb += plan.diskMb - row.diskMb;
    delta.cpuPercent += plan.cpuLimitPercent - row.cpuLimitPercent;
    deltas.set(row.nodeId, delta);
  }
  return deltas;
}

@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AgentClient,
    private readonly audit: AuditService,
    private readonly capacity: CapacityService,
    // Commercial site — the public catalog caches plan data for
    // CACHE_TTL_SECONDS; every mutation below invalidates it so an
    // admin's edit is never stuck behind a stale cache for that long.
    // Correctness never depends on this call succeeding (the cache
    // self-heals on TTL expiry regardless) — see
    // PublicPlansService.invalidateCache's own doc comment.
    private readonly publicPlans: PublicPlansService,
  ) {}

  list() {
    return this.prisma.plan.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  }

  /**
   * The client-facing catalog — needed by the upsell, which by
   * definition wants plans the customer does NOT currently have. Public
   * plans only, and only the customer-facing columns (same
   * `PLAN_CLIENT_SELECT` the server projection uses — never node-tuning
   * fields like cpuPinning/blockIoReadBps/maxSlots — see the capacity
   * plan's "Pontos em aberto" for why `maxSlots` deliberately stays out
   * of the client-facing projection).
   */
  listPublic() {
    return this.prisma.plan.findMany({
      where: { deletedAt: null, isPublic: true },
      select: PLAN_CLIENT_SELECT,
      orderBy: [{ sortOrder: 'asc' }, { memoryMb: 'asc' }],
    });
  }

  async get(id: string) {
    const plan = await this.prisma.plan.findFirst({ where: { id, deletedAt: null } });
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }

  async create(dto: CreatePlanDto) {
    assertRecommendationRanges(dto);
    const existing = await this.prisma.plan.findFirst({ where: { slug: dto.slug, deletedAt: null } });
    if (existing) throw new ConflictException('slug already in use');
    const created = await this.prisma.plan.create({
      data: {
        name: dto.name,
        slug: dto.slug,
        description: dto.description,
        cpuLimitPercent: dto.cpuLimitPercent ?? 100,
        memoryMb: dto.memoryMb,
        swapMb: dto.swapMb ?? 0,
        diskMb: dto.diskMb,
        ioWeight: dto.ioWeight ?? 500,
        oomKillEnabled: dto.oomKillEnabled ?? false,
        maxDatabases: dto.maxDatabases ?? 0,
        maxBackups: dto.maxBackups ?? 0,
        maxAllocations: dto.maxAllocations ?? 1,
        maxSchedules: dto.maxSchedules ?? 5,
        isPublic: dto.isPublic ?? true,
        sortOrder: dto.sortOrder ?? 0,
        backupRetentionDays: dto.backupRetentionDays ?? 7,
        priceCents: dto.priceCents ?? 0,
        currency: dto.currency ?? 'BRL',
        billingPeriod: dto.billingPeriod ?? 'monthly',
        // Advisory-only, all nullable — undefined leaves them NULL, which
        // means "this plan publishes no recommendation," not "0".
        recommendedPlayersMin: dto.recommendedPlayersMin,
        recommendedPlayersMax: dto.recommendedPlayersMax,
        recommendedModsMin: dto.recommendedModsMin,
        recommendedModsMax: dto.recommendedModsMax,
        recommendedPluginsMin: dto.recommendedPluginsMin,
        recommendedPluginsMax: dto.recommendedPluginsMax,
        maxServers: dto.maxServers,
        maxSlots: dto.maxSlots,
        isFeatured: dto.isFeatured ?? false,
        highlightLabel: dto.highlightLabel,
      },
    });
    await this.publicPlans.invalidateCache();
    return created;
  }

  async update(id: string, dto: UpdatePlanDto) {
    const current = await this.get(id);
    // A partial update might touch only one side of a range (e.g. just
    // recommendedModsMax) — validate against the MERGED result, not the
    // DTO alone, or a lone-field edit could silently create an invalid
    // min>max pair the DB constraint would then reject unreadably.
    assertRecommendationRanges({ ...current, ...dto });
    // Deliberately just the DB row — a plan edit alone never touches a
    // single running server (architecture doc 2.1). applyToServers is
    // the separate, explicit, audited action that does.
    const updated = await this.prisma.plan.update({ where: { id }, data: dto });
    await this.publicPlans.invalidateCache();
    return updated;
  }

  async remove(id: string) {
    await this.get(id);
    const serverCount = await this.prisma.withRLS({ userId: null, isAdmin: true }, (tx) => tx.server.count({ where: { planId: id } }));
    if (serverCount > 0) throw new ConflictException('Plan is in use by existing servers');
    await this.prisma.plan.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.publicPlans.invalidateCache();
  }

  /** Empty list = eligible everywhere (capacity plan Fase 4/5) — see `CapacityService.isNodeAllowedForPlan`. */
  async listAllowedNodes(planId: string) {
    await this.get(planId);
    return this.prisma.planNode.findMany({
      where: { planId },
      include: { node: { select: { id: true, name: true } } },
      orderBy: { priority: 'desc' },
    });
  }

  /**
   * Replaces the FULL set of eligible nodes for this plan — not a
   * per-node add/remove, so the caller always sends the complete list
   * it wants (an empty array means "no restriction," the same as never
   * having set one, not "no node is eligible" — see `isNodeAllowedForPlan`'s
   * empty-set-means-unrestricted rule). `plans` and `plan_nodes` carry no
   * RLS policy (both are global catalog tables), so this runs on the
   * bare client like `update`/`remove` above, not `withRLS`.
   */
  async setAllowedNodes(planId: string, nodes: { nodeId: string; priority?: number }[], actorId: string) {
    await this.get(planId);
    const before = await this.prisma.planNode.findMany({ where: { planId }, select: { nodeId: true, priority: true } });

    await this.prisma.$transaction([
      this.prisma.planNode.deleteMany({ where: { planId } }),
      ...nodes.map((n) => this.prisma.planNode.create({ data: { planId, nodeId: n.nodeId, priority: n.priority ?? 0 } })),
    ]);

    await this.audit.record({
      action: 'admin.plan.nodes.set',
      actorId,
      targetType: 'plan',
      targetId: planId,
      beforeState: { nodes: before },
      afterState: { nodes },
    });
    // Node eligibility feeds the public catalog's `availability`
    // (`NodeSchedulerService.selectNode` inside `computeAvailability`) —
    // a restriction change must not stay stale for the full cache TTL.
    await this.publicPlans.invalidateCache();
  }

  /**
   * The dry run half of "apply to N servers" (architecture doc 2.1/9):
   * every server still assigned this plan, diffed field-by-field against
   * the plan's CURRENT values. Read-only — computing this never touches
   * a server or the agent. Capacity plan Fase 6 adds `capacity`: the
   * same per-node wall `applyToServers` enforces, computed here WITHOUT
   * a lock (a preview, same posture as `CapacityReportService.simulate`
   * — the real gate is the lock-protected recheck inside `applyToServers`
   * itself, this is only ever a hint shown before the click).
   */
  async drift(planId: string): Promise<{
    plan: { id: string; name: string };
    affectedCount: number;
    servers: PlanDriftEntry[];
    capacity: PlanCapacityPreviewEntry[];
  }> {
    const plan = await this.get(planId);
    const rows = await this.computeDriftRows(plan);
    const servers = rows.map((r) => ({ serverId: r.id, serverName: r.name, nodeId: r.nodeId, changes: r.changes }));
    const capacity = await this.computeCapacityPreview(plan, rows);
    return { plan: { id: plan.id, name: plan.name }, affectedCount: servers.length, servers, capacity };
  }

  /**
   * Every drifted server on this plan, with the raw current values
   * `computeNodeDeltas` needs — not just the field-level diff
   * `PlanDriftEntry` exposes publicly. Runs inside the caller's own
   * transaction when one is supplied (`applyToServers` passes its
   * lock-holding `tx` so this recomputes drift freshly UNDER the lock,
   * per the capacity plan's own requirement), or opens its own
   * read-only one otherwise (the `drift()` preview). `status <>
   * 'deleting'` matches the exact exclusion `CapacityService
   * .usageForNode` already applies — a server mid-hard-delete
   * contributes to neither.
   */
  private async computeDriftRows(plan: { id: string } & Record<DriftableField, number | boolean>, tx?: Prisma.TransactionClient): Promise<DriftRow[]> {
    const query = (t: Prisma.TransactionClient) =>
      t.server.findMany({
        where: { planId: plan.id, status: { not: 'deleting' } },
        select: { id: true, name: true, nodeId: true, ...Object.fromEntries(DRIFTABLE_FIELDS.map((f) => [f, true])) },
      });
    const servers = tx ? await query(tx) : await this.prisma.withRLS({ userId: null, isAdmin: true }, query);

    const rows: DriftRow[] = [];
    for (const raw of servers) {
      // The dynamically-spread `select` (DRIFTABLE_FIELDS) defeats Prisma's
      // static return-type inference — same cast `diffFields`'s own call
      // already needed below, just applied once so every field is reachable.
      const server = raw as unknown as { id: string; name: string; nodeId: string } & Record<DriftableField, number | boolean>;
      const changes = diffFields(server, plan as unknown as Record<DriftableField, number | boolean>);
      if (changes.length > 0) {
        rows.push({ id: server.id, name: server.name, nodeId: server.nodeId, memoryMb: server.memoryMb as number, diskMb: server.diskMb as number, cpuLimitPercent: server.cpuLimitPercent as number, changes });
      }
    }
    return rows;
  }

  private async computeCapacityPreview(plan: { memoryMb: number; diskMb: number; cpuLimitPercent: number }, rows: DriftRow[]): Promise<PlanCapacityPreviewEntry[]> {
    const deltas = computeNodeDeltas(plan, rows);
    if (deltas.size === 0) return [];
    return this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      const results: PlanCapacityPreviewEntry[] = [];
      for (const [nodeId, delta] of deltas) {
        const node = await tx.node.findFirst({ where: { id: nodeId, deletedAt: null } });
        if (!node) continue;
        const usage = await this.capacity.usageForNode(tx, nodeId);
        const reasons = nodeFitReasons(node, usage, { memoryMb: delta.memoryMb, diskMb: delta.diskMb, cpuPercent: delta.cpuPercent });
        results.push({
          nodeId,
          nodeName: node.name,
          fits: reasons.length === 0,
          reasons,
          affectedServerIds: rows.filter((r) => r.nodeId === nodeId).map((r) => r.id),
        });
      }
      return results;
    });
  }

  /**
   * Actually applies the plan's current values to every drifted server —
   * capacity plan Fase 6 closes achado #1 (the biggest overselling hole
   * in the whole system: this method previously ran with ZERO capacity
   * check). One transaction: plan lock, then node locks in ascending id
   * order (the same invariant `ServersService.create` follows — see
   * capacity.locks.ts), drift recomputed fresh UNDER the lock (not the
   * pre-lock preview), per-node delta checked against every affected
   * node's real ceiling. ANY node failing refuses the WHOLE apply — no
   * partial writes, ever: "PERFORMANCE is 10GB, except on NODE 02 where
   * it's still 8" isn't a product any invoice describes, and partial
   * application would leave those servers permanently drifted, turning
   * the drift report from a real signal into noise.
   *
   * `PlansService.update` itself stays intentionally unchecked — this is
   * the only place capacity is enforced, exactly so the legitimate
   * order "raise the plan, then grow the node" keeps working.
   *
   * The best-effort agent push happens AFTER the transaction commits,
   * unchanged from before: a slow or unreachable node must never hold
   * the plan/node locks, and one unreachable node must never block the
   * rest of the batch — every failure is still returned so the admin
   * sees exactly which servers need a manual follow-up.
   */
  async applyToServers(planId: string, actorId: string): Promise<{ appliedCount: number; failures: { serverId: string; error: string }[] }> {
    await this.get(planId); // 404s early if the plan doesn't exist at all

    const { rows, plan } = await this.prisma.withRLS({ userId: null, isAdmin: true }, async (tx) => {
      await this.capacity.lockPlan(tx, planId);
      const plan = await tx.plan.findFirst({ where: { id: planId, deletedAt: null } });
      if (!plan) throw new NotFoundException('Plan not found');

      const rows = await this.computeDriftRows(plan, tx);
      if (rows.length === 0) return { rows, plan };

      const nodeIds = [...new Set(rows.map((r) => r.nodeId))].sort();
      for (const nodeId of nodeIds) await this.capacity.lockNode(tx, nodeId);

      const deltas = computeNodeDeltas(plan, rows);
      const shortfalls: string[] = [];
      for (const nodeId of nodeIds) {
        const node = await tx.node.findFirst({ where: { id: nodeId, deletedAt: null } });
        if (!node) continue; // can't actually happen — a node with servers referencing it can't be deleted (NodesService.remove's in-use guard)
        const usage = await this.capacity.usageForNode(tx, nodeId);
        const delta = deltas.get(nodeId)!;
        const reasons = nodeFitReasons(node, usage, { memoryMb: delta.memoryMb, diskMb: delta.diskMb, cpuPercent: delta.cpuPercent });
        if (reasons.length > 0) shortfalls.push(`${node.name} (${reasons.join('; ')})`);
      }
      if (shortfalls.length > 0) {
        throw new ConflictException(
          `NO_CAPACITY: applying this plan would exceed capacity on ${shortfalls.length} node(s) — ${shortfalls.join(' | ')}`,
        );
      }

      for (const row of rows) {
        await tx.server.update({
          where: { id: row.id },
          data: {
            cpuLimitPercent: plan.cpuLimitPercent,
            memoryMb: plan.memoryMb,
            swapMb: plan.swapMb,
            diskMb: plan.diskMb,
            ioWeight: plan.ioWeight,
            oomKillEnabled: plan.oomKillEnabled,
            maxDatabases: plan.maxDatabases,
            maxBackups: plan.maxBackups,
            maxSchedules: plan.maxSchedules,
          },
        });
      }
      return { rows, plan };
    });

    const failures: { serverId: string; error: string }[] = [];
    let appliedCount = 0;
    for (const row of rows) {
      const touchesLiveResources = row.changes.some((c) => LIVE_RESOURCE_FIELDS.includes(c.field));
      if (touchesLiveResources) {
        try {
          await this.agent.updateLimits(row.nodeId, row.id, {
            cpuPercent: plan.cpuLimitPercent,
            memoryMb: plan.memoryMb,
            swapMb: plan.swapMb,
            diskMb: plan.diskMb,
            ioWeight: plan.ioWeight,
          });
        } catch (err) {
          failures.push({ serverId: row.id, error: (err as Error).message });
          continue;
        }
      }
      appliedCount++;
    }

    await this.audit.record({
      action: 'plan.apply',
      targetType: 'plan',
      targetId: planId,
      actorId,
      metadata: { affectedCount: rows.length, appliedCount, failureCount: failures.length },
    });

    return { appliedCount, failures };
  }
}

function diffFields(server: Record<DriftableField, number | boolean>, plan: Record<DriftableField, number | boolean>): { field: DriftableField; from: number | boolean; to: number | boolean }[] {
  const changes: { field: DriftableField; from: number | boolean; to: number | boolean }[] = [];
  for (const field of DRIFTABLE_FIELDS) {
    if (server[field] !== plan[field]) {
      changes.push({ field, from: server[field], to: plan[field] });
    }
  }
  return changes;
}
