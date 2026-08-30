-- Milestone M13 (hardening & operations): "log partition automation".
--
-- audit_logs and server_metrics_1m were always DOCUMENTED as RANGE-
-- partitioned (architecture doc 2.1/2.3, and the doc comment directly
-- above the Prisma models) but 0001_init actually created them as plain
-- tables — Prisma's schema DSL has no partitioning syntax, and the raw-
-- SQL follow-up that was supposed to convert them never landed. This
-- migration is that follow-up: both tables become real
-- `PARTITION BY RANGE` parents, with real monthly child partitions.
--
-- audit_logs already has 1000+ real rows from every earlier milestone's
-- live testing, so this can't be a simple `CREATE TABLE ... PARTITION BY`
-- — Postgres has no "ALTER TABLE ... PARTITION BY" for an existing table.
-- The standard playbook: build the new partitioned table under a
-- temporary name, copy every row across, then swap names. server_metrics_1m
-- has zero rows (nothing writes to it yet — see api/README.md) so its
-- conversion is the same shape without a real data-loss risk, kept
-- symmetric for consistency rather than because it's load-bearing today.

-- ─────────────────────────────────────────────────────────────────
-- audit_logs
-- ─────────────────────────────────────────────────────────────────

-- A partitioned table's PRIMARY KEY must include every partition-key
-- column (Postgres requirement, not a style choice) — (id, occurred_at)
-- instead of the original bare (id). id stays globally unique in
-- practice (one sequence feeds every partition), this constraint only
-- widens what Postgres is able to prove.
CREATE TABLE "audit_logs_new" (
    "id" BIGINT NOT NULL DEFAULT nextval('audit_logs_id_seq'),
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_email" TEXT,
    "actor_ip" INET,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_logs_new_pkey" PRIMARY KEY ("id", "occurred_at")
) PARTITION BY RANGE ("occurred_at");

-- Reuse the EXISTING sequence (created by the original BIGSERIAL column)
-- instead of letting a fresh one start back at 1 — ids stay monotonic
-- and unique across the swap, no gap-filling or renumbering needed.
ALTER SEQUENCE "audit_logs_id_seq" OWNED BY "audit_logs_new"."id";

-- One partition per calendar month, covering every month real data
-- already exists in plus a rolling few months ahead so inserts never
-- fail with "no partition found" the moment a month turns over — the
-- actual operational failure mode this migration exists to prevent.
-- ensure_future_partitions() below is what keeps this window rolling
-- forward automatically after today.
CREATE TABLE "audit_logs_2026_08" PARTITION OF "audit_logs_new"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "audit_logs_2026_09" PARTITION OF "audit_logs_new"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "audit_logs_2026_10" PARTITION OF "audit_logs_new"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE "audit_logs_2026_11" PARTITION OF "audit_logs_new"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
-- Catches anything outside the explicit ranges above (pre-partitioning
-- history, clock skew, an ensure-future-partitions run that fell behind)
-- instead of an insert failing outright — a partitioned table with no
-- DEFAULT partition rejects any row that doesn't match a range.
CREATE TABLE "audit_logs_default" PARTITION OF "audit_logs_new" DEFAULT;

INSERT INTO "audit_logs_new" SELECT * FROM "audit_logs";

ALTER TABLE "audit_logs" RENAME TO "audit_logs_old";
ALTER TABLE "audit_logs_new" RENAME TO "audit_logs";
ALTER TABLE "audit_logs_2026_08" RENAME TO "audit_logs_y2026m08";
ALTER TABLE "audit_logs_2026_09" RENAME TO "audit_logs_y2026m09";
ALTER TABLE "audit_logs_2026_10" RENAME TO "audit_logs_y2026m10";
ALTER TABLE "audit_logs_2026_11" RENAME TO "audit_logs_y2026m11";
DROP TABLE "audit_logs_old";

ALTER TABLE "audit_logs" RENAME CONSTRAINT "audit_logs_new_pkey" TO "audit_logs_pkey";

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "audit_action_idx" ON "audit_logs" ("action", "occurred_at" DESC);
CREATE INDEX "audit_actor_idx" ON "audit_logs" ("actor_id", "occurred_at" DESC);

-- Re-apply the append-only posture (architecture doc 3.6) to the new
-- parent — row-level BEFORE triggers defined on a partitioned table are
-- inherited by every partition automatically (PG11+), so this one
-- definition covers all five partitions above and every one
-- ensure_future_partitions() creates later.
REVOKE UPDATE, DELETE ON "audit_logs" FROM app_user;

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END $$;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

GRANT SELECT, INSERT ON "audit_logs" TO app_user;

-- ─────────────────────────────────────────────────────────────────
-- server_metrics_1m — same shape, empty table, no data-copy step needed.
-- Its existing PK ("server_id","bucket") already includes the intended
-- partition key, so nothing about the constraint needs to change.
-- ─────────────────────────────────────────────────────────────────

DROP TABLE "server_metrics_1m";

CREATE TABLE "server_metrics_1m" (
    "server_id" UUID NOT NULL,
    "bucket" TIMESTAMPTZ NOT NULL,
    "cpu_percent" DOUBLE PRECISION NOT NULL,
    "memory_bytes" BIGINT NOT NULL,
    "disk_bytes" BIGINT NOT NULL,
    "net_rx_bytes" BIGINT NOT NULL,
    "net_tx_bytes" BIGINT NOT NULL,

    CONSTRAINT "server_metrics_1m_pkey" PRIMARY KEY ("server_id", "bucket")
) PARTITION BY RANGE ("bucket");

CREATE TABLE "server_metrics_1m_y2026m08" PARTITION OF "server_metrics_1m"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE "server_metrics_1m_y2026m09" PARTITION OF "server_metrics_1m"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE "server_metrics_1m_default" PARTITION OF "server_metrics_1m" DEFAULT;

ALTER TABLE "server_metrics_1m" ADD CONSTRAINT "server_metrics_1m_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

GRANT SELECT, INSERT, UPDATE, DELETE ON "server_metrics_1m" TO app_user;

-- ─────────────────────────────────────────────────────────────────
-- Automation: a function the worker's partition-maintenance job calls
-- on a schedule (PartitionMaintenanceService, run daily) to keep a
-- rolling window of future partitions ahead of the current date, for
-- BOTH tables above — idempotent (IF NOT EXISTS) so a re-run or two
-- worker processes racing never errors.
-- ─────────────────────────────────────────────────────────────────

-- SECURITY DEFINER: app_user has table-level DML grants but no CREATE
-- privilege on the public schema (by design — DDL is the migration
-- role's job, not the request-serving role's). These two functions run
-- as their OWNER (the migration role) instead, the same reasoning
-- 0002_rls_policies already applies to can_access_server().
CREATE OR REPLACE FUNCTION ensure_future_partitions(months_ahead int DEFAULT 3) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  i int;
  range_start date;
  range_end date;
  part_name text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    range_start := date_trunc('month', now() + (i || ' months')::interval)::date;
    range_end := (range_start + interval '1 month')::date;

    part_name := 'audit_logs_y' || to_char(range_start, 'YYYY') || 'm' || to_char(range_start, 'MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)', part_name, range_start, range_end);
    END IF;

    part_name := 'server_metrics_1m_y' || to_char(range_start, 'YYYY') || 'm' || to_char(range_start, 'MM');
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = part_name) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF server_metrics_1m FOR VALUES FROM (%L) TO (%L)', part_name, range_start, range_end);
    END IF;
  END LOOP;
END $$;

-- Retention: server_metrics_1m is high-volume, low-value long-term
-- (raw per-minute samples nobody queries past a dashboard's own
-- lookback window) — old partitions are DETACHED (never DROPPED) into
-- an archive schema, so "log partition automation" never means silent
-- data loss even for the table where it would be low-stakes. audit_logs
-- has no equivalent function on purpose: a security trail should not
-- have code anywhere capable of making it shorter — see
-- PartitionMaintenanceService's doc comment for the full reasoning.
CREATE SCHEMA IF NOT EXISTS log_archive;

CREATE OR REPLACE FUNCTION archive_old_metric_partitions(older_than_months int DEFAULT 6) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  cutoff date := date_trunc('month', now() - (older_than_months || ' months')::interval)::date;
  part record;
BEGIN
  FOR part IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_inherits i ON i.inhrelid = c.oid
    JOIN pg_class parent ON parent.oid = i.inhparent
    WHERE parent.relname = 'server_metrics_1m'
      AND c.relname <> 'server_metrics_1m_default'
      AND to_date(substring(c.relname from 'y(\d{4})m\d{2}$'), 'YYYY') IS NOT NULL
      AND (
        to_date(substring(c.relname from 'y(\d{4})m(\d{2})$'), 'YYYY') +
        (substring(c.relname from 'y\d{4}m(\d{2})$')::int - 1 || ' months')::interval
      ) < cutoff
  LOOP
    EXECUTE format('ALTER TABLE server_metrics_1m DETACH PARTITION %I', part.relname);
    EXECUTE format('ALTER TABLE %I SET SCHEMA log_archive', part.relname);
  END LOOP;
END $$;
