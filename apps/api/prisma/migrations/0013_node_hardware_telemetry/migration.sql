-- Hardware-capacity detection: deeper host telemetry than Fase 7's
-- reported_* block ever collected (CPU model/topology, current
-- usage/load, memory used/available, virtualization). Purely
-- informational/display, same as the columns added in
-- 0011_node_reported_telemetry — never enters capacity math
-- (capacity.math.ts/capacity.service.ts stay 100% based on the declared
-- memory_total_mb/disk_total_mb/cpu_total_percent columns) and never
-- enters deriveTelemetryDivergence's declared×reported comparison,
-- which stays scoped to memory/disk/cpu totals only.
--
-- reported_cpu_physical_cores/reported_cpu_sockets are deliberately left
-- NULL by the agent when it detects it's running inside an LXC container
-- (see agent's internal/hostinfo package) — /proc/cpuinfo isn't
-- namespaced there, so reporting them would leak the HOST's physical
-- topology into what should be the guest's own capacity.
ALTER TABLE "nodes" ADD COLUMN "reported_cpu_model" TEXT;
ALTER TABLE "nodes" ADD COLUMN "reported_cpu_sockets" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_cpu_physical_cores" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_cpu_usage_percent" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_load_avg_1" DOUBLE PRECISION;
ALTER TABLE "nodes" ADD COLUMN "reported_memory_used_mb" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_memory_available_mb" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_virtualization_system" TEXT;
ALTER TABLE "nodes" ADD COLUMN "reported_virtualization_role" TEXT;
