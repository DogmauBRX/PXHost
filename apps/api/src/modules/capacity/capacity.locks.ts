import type { Prisma } from '@prisma/client';

/**
 * The advisory-lock keys every capacity-checking transaction takes.
 *
 * ⚠️ LOCK ORDERING INVARIANT (binding on every future caller, not just the
 * ones that exist today): **plan lock first, then node lock(s), node
 * locks ascending by id.** `ServersService.create` only takes a node lock
 * today (Fase 1) — the plan lock arrives in Fase 4 once `Plan.maxSlots`
 * exists and a per-plan lock is the only thing that closes the cross-node
 * slot race (two concurrent creates of the SAME plan on DIFFERENT nodes
 * take disjoint node locks and can both pass the same slot check). The
 * key string for a node is preserved character-for-character across that
 * change so old and new code contend on the same lock during the
 * transition, and `PlansService.applyToServers` (Fase 6) must take its
 * node locks in ascending id order for the same reason: any code path
 * that reverses this order is a live deadlock (Postgres error 40P01)
 * waiting for two transactions to race.
 */
export async function lockNode(tx: Prisma.TransactionClient, nodeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('node:' || ${nodeId}))`;
}

/**
 * MUST be taken before any `lockNode` call in the same transaction — see
 * this file's own doc comment for the full deadlock analysis. A
 * different key namespace (`plan:` vs `node:`) means a plan id and a
 * node id that happen to collide as raw UUIDs can never hash to the same
 * lock.
 */
export async function lockPlan(tx: Prisma.TransactionClient, planId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('plan:' || ${planId}))`;
}
