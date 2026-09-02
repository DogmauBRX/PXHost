-- Capacity plan Fase 4: commercial stock per plan (vagas) and which
-- nodes a plan may be scheduled onto.

-- NULL = unlimited (every existing plan reads this way — zero behavior
-- change for anything created before this migration); 0 = sold out
-- without deleting or hiding the plan. Occupancy itself is never a
-- stored column (see the doc comment on Plan.maxSlots in schema.prisma
-- for why: servers are hard-deleted with no counter-maintaining hook).
ALTER TABLE "plans" ADD COLUMN "max_slots" INTEGER;

-- Same join-table shape as the existing mount_nodes (0001_init): which
-- nodes a plan may be scheduled onto. A plan with zero rows here is
-- eligible everywhere — this is an opt-IN restriction, so no plan needs
-- a backfill row to keep its current (everywhere-eligible) behavior.
CREATE TABLE "plan_nodes" (
    "plan_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "plan_nodes_pkey" PRIMARY KEY ("plan_id", "node_id")
);

ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_nodes" ADD CONSTRAINT "plan_nodes_node_id_fkey"
  FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- `plan_nodes` carries no RLS policy — both `plans` and `nodes` are
-- global catalog tables today (no RLS policy of their own either; see
-- PrismaService's own doc comment on which tables are RLS-protected),
-- and a plan-to-node eligibility mapping is exactly the same kind of
-- global catalog data.

-- Feeds occupancy counting (Fase 4) and the scheduler's elimination
-- filter (Fase 5) — both query "how many/which servers on this plan are
-- not being deleted", the same shape `usageForNode`'s own aggregate
-- already filters on.
CREATE INDEX "servers_plan_id_status_idx" ON "servers" ("plan_id", "status");

-- Achado/decision from the capacity plan: never revived, always going to
-- be replaced by PlanNode. No code ever read this column for anything
-- but documentation examples (verified: zero references outside two
-- comments, both updated in this same change) — safe to drop outright,
-- no backfill needed.
ALTER TABLE "plans" DROP COLUMN "allowed_group_ids";
