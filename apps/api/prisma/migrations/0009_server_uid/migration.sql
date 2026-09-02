-- Capacity plan Fase 1, bug fix #3: `uid` (the Linux uid the agent runs a
-- server's container as, and chowns its bind-mounted data directory to —
-- see agent's fsx.Jail) was never persisted anywhere. Both create() and
-- the transfer pipeline approximated it as `UID_BASE + count(servers on
-- node)`, which is wrong the instant any server on that node is
-- hard-deleted: the count drops, and the very next create reuses an
-- already-used uid. That is a real tenant-isolation concern, not
-- cosmetic — Server.Remove() on the agent deliberately never deletes the
-- data directory (see its own doc comment), so a reused uid means a new
-- container could run under the same Linux uid an old, unrelated
-- customer's leftover files are still owned by.
--
-- Both columns are nullable: existing servers keep whatever uid their
-- already-running container has (nothing here needs to re-derive it for
-- a server that never stops running), and `servers_target_uid` on
-- server_transfers mirrors the existing target_allocation_id column —
-- decided once, under the target node's advisory lock, at pipeline
-- start, and consumed at result time so the persisted value always
-- matches what the container was actually created with.

ALTER TABLE "servers" ADD COLUMN "uid" INTEGER;
CREATE INDEX "servers_node_uid_idx" ON "servers" ("node_id", "uid");

ALTER TABLE "server_transfers" ADD COLUMN "target_uid" INTEGER;

-- Neither table gains a new RLS policy — both already have one
-- (0002_rls_policies) and a nullable column needs no policy change.
