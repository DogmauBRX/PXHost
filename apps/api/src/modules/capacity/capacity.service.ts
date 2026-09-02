import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockNode, lockPlan } from './capacity.locks';
import type { NodeUsage } from './capacity.math';

/** Every server that has EVER been assigned a uid on a node starts counting from here — unchanged from the pre-capacity-Fase-1 constant of the same name in servers.service.ts/transfers.service.ts. */
export const UID_BASE = 100000;

/** `server_transfers.status` values that still hold the target node's resources — everything short of a terminal state (success/failed/cancelled). Mirrors the `server_transfers_status_check` CHECK constraint's non-terminal members. */
const ACTIVE_TRANSFER_STATUSES = ['pending', 'archiving', 'uploading', 'restoring'] as const;

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
   * Servers currently on this plan, same `status <> 'deleting'` exclusion
   * `usageForNode` applies — a slot and a unit of node capacity can never
   * disagree about whether a mid-hard-delete server still counts.
   */
  async occupiedSlots(tx: Prisma.TransactionClient, planId: string): Promise<number> {
    return tx.server.count({ where: { planId, status: { not: 'deleting' } } });
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
