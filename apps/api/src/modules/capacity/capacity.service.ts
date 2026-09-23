import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockNode, lockPlan } from './capacity.locks';
import { nodeAcceptsNewServers, resolveNodeCapacity, slotsForPlanOnNode, type NodeUsage } from './capacity.math';
import { deriveHealthStatus } from '../nodes/nodes.service';

/** Every server that has EVER been assigned a uid on a node starts counting from here — unchanged from the pre-capacity-Fase-1 constant of the same name in servers.service.ts/transfers.service.ts. */
export const UID_BASE = 100000;

/** `server_transfers.status` values that still hold the target node's resources — everything short of a terminal state (success/failed/cancelled). Mirrors the `server_transfers_status_check` CHECK constraint's non-terminal members. */
const ACTIVE_TRANSFER_STATUSES = ['pending', 'archiving', 'uploading', 'restoring'] as const;

/**
 * Only a payment-confirmed subscription without a server holds a
 * commercial slot. `pending` is deliberately absent: a customer may
 * abandon checkout without consuming inventory. `past_due` and
 * `suspended` are absent for the same reason when no server was ever
 * provisioned; a paid subscription that already has a server continues
 * to count through source (1) below, until that server is deleted.
 */
export const SLOT_HOLDING_SUBSCRIPTION_STATUSES = ['active'] as const;

/**
 * The shared building blocks every resource-allocating write path uses:
 * `ServersService.create` and `TransfersService.initiate` today; a future
 * `PlansService.applyToServers` capacity gate (Fase 6) and
 * `NodeSchedulerService` (Fase 5) reuse the same `usageForNode` this
 * class already computes correctly.
 *
 * Every method here takes `tx: Prisma.TransactionClient` as its first
 * argument — the CALLER owns the transaction and whatever advisory locks
 * it has already taken (`lockNode` included, so it can be awaited inside
 * the same transaction the caller is building). A later read-only
 * reporting layer (capacity Fase 2) wraps these same methods in its own
 * `withRLS`, never duplicates their logic. Never call any of these with
 * a bare, un-transacted client — `servers` and `allocations` are
 * RLS-protected, and a query outside `withRLS`'s `SET LOCAL` context
 * silently returns zero rows instead of erroring (see PrismaService's
 * own doc comment — this exact bug class has shipped twice already).
 */
@Injectable()
export class CapacityService {
  async lockNode(tx: Prisma.TransactionClient, nodeId: string): Promise<void> {
    await lockNode(tx, nodeId);
  }

  /** MUST be called before `lockNode` in the same transaction — see capacity.locks.ts's ordering invariant. */
  async lockPlan(tx: Prisma.TransactionClient, planId: string): Promise<void> {
    await lockPlan(tx, planId);
  }

  /**
   * Occupied commercial slots for this plan — two disjoint sources, added
   * together, never double-counted:
   *
   *  1. Servers currently on this plan, same `status <> 'deleting'`
   *     exclusion `usageForNode` applies — a slot and a unit of node
   *     capacity can never disagree about whether a mid-hard-delete
   *     server still counts.
   *  2. Payment-confirmed subscriptions (commercial site) on this plan
   *     that have NOT yet been provisioned a server (`serverId IS NULL`).
   *     A `pending` checkout does not reserve inventory; activation at
   *     payment confirmation is the point where this source starts counting.
   *
   * The `serverId IS NULL` filter on (2) is what keeps this from ever
   * double-counting: the instant a subscription is attached to a server
   * (future auto-provisioning, or an admin linking one by hand), it
   * drops out of (2) and its server picks up the slot in (1) instead —
   * the two sets are always disjoint by construction, never by a
   * point-in-time coincidence. The paid activation/provisioning path calls
   * this same method under the plan lock, so multiple abandoned checkouts
   * can coexist while the first payment that reaches `active` still cannot
   * oversell the plan.
   */
  async occupiedSlots(tx: Prisma.TransactionClient, planId: string): Promise<number> {
    const [servers, subscriptions] = await Promise.all([
      tx.server.count({ where: { planId, status: { not: 'deleting' } } }),
      tx.subscription.count({ where: { planId, serverId: null, status: { in: [...SLOT_HOLDING_SUBSCRIPTION_STATUSES] } } }),
    ]);
    return servers + subscriptions;
  }

  /**
   * A plan with zero `PlanNode` rows is eligible on every node — opt-in
   * restriction, so a plan created before Fase 4 (or one an admin never
   * bothered to restrict) behaves exactly as it always has.
   */
  async isNodeAllowedForPlan(tx: Prisma.TransactionClient, planId: string, nodeId: string): Promise<boolean> {
    const restrictions = await tx.planNode.count({ where: { planId } });
    if (restrictions === 0) return true;
    const allowed = await tx.planNode.count({ where: { planId, nodeId } });
    return allowed > 0;
  }

  /**
   * Committed usage for a node: the sum of every non-`deleting` server's
   * snapshot resources, PLUS the resources of any server currently
   * mid-transfer INTO this node. That second term is a real bug fix, not
   * a new feature — `TransfersService.initiate` already checks the
   * target's capacity and reserves its allocation, but the server's OWN
   * `nodeId` doesn't flip to the target until `handleResult` fires,
   * which can be minutes later for a large archive. Without this term, a
   * concurrent create can consume exactly the memory/disk a transfer
   * already promised to the target, and the transfer then lands on an
   * overcommitted node with no error anywhere.
   */
  async usageForNode(tx: Prisma.TransactionClient, nodeId: string): Promise<NodeUsage> {
    const [settled, inFlight] = await Promise.all([
      tx.server.aggregate({
        where: { nodeId, status: { not: 'deleting' } },
        _sum: { memoryMb: true, diskMb: true, cpuLimitPercent: true },
      }),
      tx.serverTransfer.findMany({
        where: { targetNodeId: nodeId, status: { in: [...ACTIVE_TRANSFER_STATUSES] } },
        select: { server: { select: { memoryMb: true, diskMb: true, cpuLimitPercent: true } } },
      }),
    ]);

    const inFlightMemory = inFlight.reduce((sum, t) => sum + t.server.memoryMb, 0);
    const inFlightDisk = inFlight.reduce((sum, t) => sum + t.server.diskMb, 0);
    const inFlightCpu = inFlight.reduce((sum, t) => sum + t.server.cpuLimitPercent, 0);

    return {
      memoryMb: (settled._sum.memoryMb ?? 0) + inFlightMemory,
      diskMb: (settled._sum.diskMb ?? 0) + inFlightDisk,
      cpuPercent: (settled._sum.cpuLimitPercent ?? 0) + inFlightCpu,
    };
  }

  /**
   * Batched sibling of `usageForNode` — capacity plan (auto-derivation)
   * §11's per-plan-per-node vagas display and the public catalog's
   * capacity-aware availability both need usage for EVERY node at once;
   * looping `usageForNode` there would be N+1 queries per request. Same
   * two-source sum (settled servers + in-flight incoming transfers),
   * batched with `groupBy`/a single `findMany` instead of per-node
   * `aggregate` calls. Read-only reporting only — the locked create/
   * transfer paths keep calling `usageForNode` under the node's advisory
   * lock, never this.
   */
  async usageForNodes(tx: Prisma.TransactionClient, nodeIds: string[]): Promise<Map<string, NodeUsage>> {
    const usage = new Map<string, NodeUsage>(nodeIds.map((id) => [id, { memoryMb: 0, diskMb: 0, cpuPercent: 0 }]));
    if (nodeIds.length === 0) return usage;

    const [settled, inFlight] = await Promise.all([
      tx.server.groupBy({
        by: ['nodeId'],
        where: { nodeId: { in: nodeIds }, status: { not: 'deleting' } },
        _sum: { memoryMb: true, diskMb: true, cpuLimitPercent: true },
      }),
      tx.serverTransfer.findMany({
        where: { targetNodeId: { in: nodeIds }, status: { in: [...ACTIVE_TRANSFER_STATUSES] } },
        select: { targetNodeId: true, server: { select: { memoryMb: true, diskMb: true, cpuLimitPercent: true } } },
      }),
    ]);

    for (const row of settled) {
      const u = usage.get(row.nodeId);
      if (!u) continue;
      u.memoryMb += row._sum.memoryMb ?? 0;
      u.diskMb += row._sum.diskMb ?? 0;
      u.cpuPercent += row._sum.cpuLimitPercent ?? 0;
    }
    for (const t of inFlight) {
      const u = usage.get(t.targetNodeId);
      if (!u) continue;
      u.memoryMb += t.server.memoryMb;
      u.diskMb += t.server.diskMb;
      u.cpuPercent += t.server.cpuLimitPercent;
    }
    return usage;
  }

  /**
   * Whether AT LEAST ONE node in the whole system is genuinely deployed
   * and roughly alive — 'online' or 'degraded', never 'unknown' (never
   * heartbeated, e.g. a fresh dev DB with plans but no bootstrapped
   * agent yet) or 'offline'. The ONE gate `PublicPlansService` checks
   * before letting real node capacity influence the public catalog at
   * all — see that service's own doc comment for the exact incident
   * ("every plan showed Esgotado on a fresh DB with zero nodes") this
   * exists to prevent from ever happening again, now scoped correctly:
   * an infra outage or a not-yet-deployed environment falls back to
   * maxSlots-only availability instead of blanking the whole storefront.
   */
  async hasAnyHealthyNode(tx: Prisma.TransactionClient): Promise<boolean> {
    const nodes = await tx.node.findMany({ where: { deletedAt: null }, select: { lastHeartbeatAt: true } });
    return nodes.some((n) => {
      const health = deriveHealthStatus(n.lastHeartbeatAt);
      return health === 'online' || health === 'degraded';
    });
  }

  /**
   * Sum of `slotsForPlanOnNode` across every node eligible for (respecting
   * `PlanNode` restrictions, same opt-in rule `isNodeAllowedForPlan`
   * enforces on write) and currently ACCEPTING new servers for each plan
   * — the same computation `CapacityReportService.planUsage()` makes per
   * plan for the admin UI, factored out here so `PublicPlansService` (a
   * different module, no per-node breakdown needed) can reuse the exact
   * same rule without a second implementation. `null` in the returned
   * map means unlimited on every eligible, accepting node (or no
   * eligible node contributed a finite number at all).
   *
   * Only call this after confirming `hasAnyHealthyNode` — this method
   * itself doesn't check that, so a caller that skips the check would
   * reproduce the exact "everything looks sold out" bug that guard
   * exists to prevent.
   */
  async derivedSlotsForPlans(
    tx: Prisma.TransactionClient,
    plans: { id: string; memoryMb: number; diskMb: number; cpuLimitPercent: number }[],
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (plans.length === 0) return result;

    const [nodes, planNodeRows] = await Promise.all([
      tx.node.findMany({ where: { deletedAt: null } }),
      tx.planNode.findMany({ where: { planId: { in: plans.map((p) => p.id) } } }),
    ]);
    const usageByNode = await this.usageForNodes(tx, nodes.map((n) => n.id));

    const restrictionsByPlan = new Map<string, Set<string>>();
    for (const row of planNodeRows) {
      if (!restrictionsByPlan.has(row.planId)) restrictionsByPlan.set(row.planId, new Set());
      restrictionsByPlan.get(row.planId)!.add(row.nodeId);
    }

    for (const plan of plans) {
      const restricted = restrictionsByPlan.get(plan.id);
      const eligibleNodes = restricted ? nodes.filter((n) => restricted.has(n.id)) : nodes;
      const request = { memoryMb: plan.memoryMb, diskMb: plan.diskMb, cpuPercent: plan.cpuLimitPercent };

      // Starts at 0 (not null) — a plan with no eligible/accepting node
      // anywhere has ZERO real capacity, never "unlimited". The instant
      // ANY eligible+accepting node reports unlimited (null) for this
      // plan, the whole sum flips to null and STAYS there — one node
      // that can host infinitely many is enough to make the plan
      // unlimited overall, regardless of what any other node contributes.
      let derived: number | null = 0;
      for (const node of eligibleNodes) {
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
        if (!acceptance.ok) continue; // contributes 0 — same as planUsage()'s per-node "reason" path
        const usage = usageByNode.get(node.id) ?? { memoryMb: 0, diskMb: 0, cpuPercent: 0 };
        const { slots } = slotsForPlanOnNode(resolved, usage, request);
        if (slots === null) derived = null;
        else if (derived !== null) derived += slots;
      }
      result.set(plan.id, derived);
    }
    return result;
  }

  /**
   * The next uid to assign on this node — `max(uid) + 1` over every
   * server that has ever held one there, falling back to `UID_BASE` for
   * a node with none yet. Replaces the old `UID_BASE + count(...)`
   * approximation, which reused an already-used uid the instant a server
   * on the node was hard-deleted (the count drops; the max never does).
   * MUST be called with the node's advisory lock already held by the
   * caller's transaction, or two concurrent creates on the same node can
   * still compute the same "next" uid.
   */
  async nextUid(tx: Prisma.TransactionClient, nodeId: string): Promise<number> {
    const result = await tx.server.aggregate({ where: { nodeId }, _max: { uid: true } });
    const highest = result._max.uid ?? UID_BASE - 1;
    return Math.max(highest, UID_BASE - 1) + 1;
  }

  /**
   * Picks a free allocation within an already-decided node — moved
   * verbatim from servers.service.ts. `FOR UPDATE SKIP LOCKED` under the
   * node's advisory lock: even without the advisory lock this would
   * prevent two transactions from picking the SAME row, but the advisory
   * lock is what makes the capacity check race-free — allocation picking
   * has its own, independent protection here as a second layer.
   */
  async pickFreeAllocation(tx: Prisma.TransactionClient, nodeId: string): Promise<{ id: bigint; ip: string; port: number } | null> {
    // host(ip), not ip::text: Postgres's inet type carries an implicit
    // /32 netmask, and ::text renders it ("203.0.113.50/32") — which
    // Docker's daemon then rejects outright when building the
    // container's port bindings (confirmed live: "ParseAddr(...):
    // unexpected character (at "/32")"). host() strips the mask,
    // returning the bare address the agent actually expects.
    const rows = await tx.$queryRaw<{ id: bigint; ip: string; port: number }[]>`
      SELECT id, host(ip) as ip, port FROM allocations
      WHERE node_id = ${nodeId}::uuid AND server_id IS NULL
      ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    return rows[0] ?? null;
  }

  /**
   * Read-only sibling of `pickFreeAllocation` for the scheduler (Fase
   * 5), which runs UNLOCKED as a hint (see `NodeSchedulerService`'s own
   * doc comment) — counting is enough there, no row needs picking or
   * locking. Never used by the actual create path, which still calls
   * `pickFreeAllocation` under the node's advisory lock.
   */
  async freeAllocationCount(tx: Prisma.TransactionClient, nodeId: string): Promise<number> {
    return tx.allocation.count({ where: { nodeId, serverId: null } });
  }
}
