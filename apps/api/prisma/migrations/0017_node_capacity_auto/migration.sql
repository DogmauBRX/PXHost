-- Capacity plan (auto-derivation) — a node opts INTO automatic capacity
-- derived from agent telemetry; 'manual' (the default, applied to every
-- existing row by this migration) keeps the DECLARED columns
-- (memory_total_mb/disk_total_mb/cpu_total_percent/...) as the ceiling,
-- byte-for-byte the same behavior every node has today. Nothing about
-- this migration changes what a single existing node accepts or refuses
-- — see capacity.math.ts's resolveNodeCapacity for the one place that
-- branches on capacity_mode.
ALTER TABLE "nodes" ADD COLUMN "capacity_mode" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_capacity_mode_check"
  CHECK ("capacity_mode" IN ('manual', 'auto'));

-- Safety margin, applied on top of the existing admin reserve
-- (*_reserved_mb / cpu_reserved_percent) only in 'auto' mode — folded
-- into resolveNodeCapacity's effective "reserved" before it reaches
-- ceilingFor, so ceilingFor/assertCapacity/headroomFor/snapshotDimension
-- themselves need no changes. Defaults act as this feature's global
-- default (no settings table exists in this schema — see schema.prisma's
-- own comment on these columns).
ALTER TABLE "nodes" ADD COLUMN "memory_safety_margin_pct" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "nodes" ADD COLUMN "disk_safety_margin_pct" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "nodes" ADD COLUMN "cpu_safety_margin_pct" INTEGER NOT NULL DEFAULT 10;
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_safety_margin_check" CHECK (
  "memory_safety_margin_pct" BETWEEN 0 AND 90 AND
  "disk_safety_margin_pct" BETWEEN 0 AND 90 AND
  "cpu_safety_margin_pct" BETWEEN 0 AND 90
);

-- Usage-percent thresholds for capacityStatus's 4 levels
-- (normal/warning/high/critical) — applies in both capacity modes.
ALTER TABLE "nodes" ADD COLUMN "capacity_warn_pct" INTEGER NOT NULL DEFAULT 70;
ALTER TABLE "nodes" ADD COLUMN "capacity_high_pct" INTEGER NOT NULL DEFAULT 85;
ALTER TABLE "nodes" ADD COLUMN "capacity_critical_pct" INTEGER NOT NULL DEFAULT 95;
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_thresholds_check" CHECK (
  "capacity_warn_pct" < "capacity_high_pct" AND
  "capacity_high_pct" < "capacity_critical_pct" AND
  "capacity_critical_pct" <= 100
);

-- The node's own cgroup memory limit (agent-reported) — see
-- schema.prisma's doc comment on this column for why it's distinct from
-- reported_memory_total_mb (the LXC-vs-host RAM problem).
ALTER TABLE "nodes" ADD COLUMN "reported_memory_limit_mb" INTEGER;

-- The two existing CHECKs below assumed the DECLARED columns were
-- always the source of truth. In 'auto' mode they're not (total comes
-- from telemetry, resolved entirely in application code before it ever
-- reaches ceilingFor) — both CHECKs are relaxed to only apply in
-- 'manual' mode, everything else about them (including every bound
-- that already validates real data) is unchanged.
ALTER TABLE "nodes" DROP CONSTRAINT "nodes_cpu_accounting_check";
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_cpu_accounting_check"
  CHECK ("capacity_mode" = 'auto' OR "cpu_overallocate_pct" = -1 OR "cpu_total_percent" > 0);

ALTER TABLE "nodes" DROP CONSTRAINT "nodes_memory_reserved_check";
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_memory_reserved_check"
  CHECK ("memory_reserved_mb" >= 0 AND ("capacity_mode" = 'auto' OR "memory_reserved_mb" <= "memory_total_mb"));

ALTER TABLE "nodes" DROP CONSTRAINT "nodes_disk_reserved_check";
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_disk_reserved_check"
  CHECK ("disk_reserved_mb" >= 0 AND ("capacity_mode" = 'auto' OR "disk_reserved_mb" <= "disk_total_mb"));

ALTER TABLE "nodes" DROP CONSTRAINT "nodes_cpu_reserved_check";
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_cpu_reserved_check"
  CHECK ("cpu_reserved_percent" >= 0 AND ("capacity_mode" = 'auto' OR "cpu_reserved_percent" <= "cpu_total_percent"));
