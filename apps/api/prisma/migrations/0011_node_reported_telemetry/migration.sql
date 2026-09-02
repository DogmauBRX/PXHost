-- Capacity plan Fase 2 (schema only — the Go agent doesn't send any of
-- these yet; that wiring is Fase 7). Nullable columns for what the agent
-- ACTUALLY reports about the host it's running on, kept strictly
-- separate from the existing `memory_total_mb`/`disk_total_mb`/
-- `cpu_total_percent` columns, which are the admin's DECLARED commercial
-- capacity. Nothing in this codebase ever copies a reported_* value into
-- a declared column — see nodes.service.ts's read-time divergence logic
-- (Fase 3) for why that distinction has to stay load-bearing: the agent
-- runs directly on the Proxmox host (Fase 0 decision), so reported RAM
-- includes whatever Proxmox and its other VMs are using, and declaring
-- less than the physical total is the normal, correct, non-alarming case.
ALTER TABLE "nodes" ADD COLUMN "reported_memory_total_mb" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_cpu_count" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_disk_total_mb" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_disk_free_mb" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_os" TEXT;
ALTER TABLE "nodes" ADD COLUMN "reported_kernel" TEXT;
ALTER TABLE "nodes" ADD COLUMN "reported_containers_running" INTEGER;
ALTER TABLE "nodes" ADD COLUMN "reported_at" TIMESTAMPTZ;

-- `HeartbeatDto.uptimeSeconds` has existed and been silently discarded by
-- NodeBootstrapService.heartbeat since M4 — this finally gives it a home.
-- Separate from `reported_at` because a heartbeat can legitimately update
-- one without the other once Fase 7's best-effort collection lands (each
-- source in the agent's `send()` is independently best-effort).
ALTER TABLE "nodes" ADD COLUMN "agent_uptime_seconds" INTEGER;
