-- Capacity plan Fase 2: CPU accounting + DB-level guardrails on the
-- reserve/overallocate combinations an admin can put on a node.
--
-- `cpu_reserved_percent` is the CPU twin of the existing
-- `memory_reserved_mb`/`disk_reserved_mb` — "percent of this node's CPU
-- that isn't mine to sell" (the same host also runs Proxmox itself and,
-- per the M4/M5 topology decision, the agent runs directly on the
-- Proxmox host, so this reserve is literally covering the hypervisor's
-- own overhead, same as memory). Defaults to 0, matching every existing
-- row and the "CPU accounting off by default" decision (Fase 0 answers).

ALTER TABLE "nodes" ADD COLUMN "cpu_reserved_percent" INTEGER NOT NULL DEFAULT 0;

-- Achado #4 (see capacity plan): before this, turning on CPU accounting
-- with `cpu_total_percent` left at its 0 default would let
-- `assertCapacity('cpu', …)` compute a teto based on total=0. In practice
-- `capacity.math.ts`'s `ceilingFor` already treats any `total <= 0` as
-- unlimited (Fase 1's own rounding fix), so the application code cannot
-- actually produce a zero-ceiling refusal — but that safety net living
-- ONLY in one function is exactly the kind of thing a future code path
-- could bypass. This CHECK makes the nonsensical combination (CPU
-- overallocate is a real percentage, but total is unset) impossible to
-- persist at all, independent of which code path writes the row. Every
-- existing node has cpu_overallocate_pct = -1, so this validates against
-- current data with no backfill.
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_cpu_accounting_check"
  CHECK ("cpu_overallocate_pct" = -1 OR "cpu_total_percent" > 0);

-- Reserved must sit inside [0, total] for every dimension — an admin
-- reserving more than the node physically has, or a negative reserve,
-- has no sane interpretation and today only the DTO's `@Min(0)` stops it
-- (nothing stops reserved > total at either layer).
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_memory_reserved_check"
  CHECK ("memory_reserved_mb" >= 0 AND "memory_reserved_mb" <= "memory_total_mb");
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_disk_reserved_check"
  CHECK ("disk_reserved_mb" >= 0 AND "disk_reserved_mb" <= "disk_total_mb");
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_cpu_reserved_check"
  CHECK ("cpu_reserved_percent" >= 0 AND "cpu_reserved_percent" <= "cpu_total_percent");

-- Overallocate's valid range is `-1` (unlimited) or any non-negative
-- percentage, for ALL THREE dimensions — verified against actual
-- behavior, not assumed: `ceilingFor` in capacity.math.ts treats
-- `overallocatePct === -1` as unlimited uniformly regardless of
-- dimension, and test/servers.e2e-spec.ts's own capacity test
-- (`diskOverallocatePct: -1 // unlimited: isolate memory as the sole
-- capacity bottleneck`) already depends on -1 meaning unlimited for
-- disk, not just CPU. A `>= 0` constraint on memory/disk would reject
-- that already-passing, already-shipped scenario, so the constraint
-- below matches the code's real, tested semantics rather than treating
-- CPU as the only dimension where -1 is valid.
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_memory_overallocate_check"
  CHECK ("memory_overallocate_pct" >= -1);
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_disk_overallocate_check"
  CHECK ("disk_overallocate_pct" >= -1);
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_cpu_overallocate_check"
  CHECK ("cpu_overallocate_pct" >= -1);
