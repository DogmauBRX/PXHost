-- Nightly/manual canary runs: real servers created, booted, power-cycled,
-- reinstalled and deleted on the production nodes, one row per run with the
-- per-scenario step results. Admin-only data.
CREATE TABLE "canary_runs" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "trigger" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "summary" TEXT,
  "results" JSONB NOT NULL DEFAULT '[]',
  "diagnostics" JSONB,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ,
  CONSTRAINT "canary_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "canary_runs_started_at_idx" ON "canary_runs"("started_at");

ALTER TABLE "canary_runs" ADD CONSTRAINT "canary_runs_trigger_check" CHECK ("trigger" IN ('schedule', 'manual'));
ALTER TABLE "canary_runs" ADD CONSTRAINT "canary_runs_status_check" CHECK ("status" IN ('running', 'passed', 'failed'));

ALTER TABLE "canary_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY canary_runs_admin ON "canary_runs"
  USING (current_app_is_admin())
  WITH CHECK (current_app_is_admin());
