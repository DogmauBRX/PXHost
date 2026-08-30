-- Row-Level Security: the tenancy backstop described in architecture doc
-- 2.4. Deliberately a SEPARATE migration from the table DDL (0001_init) so
-- it can be reviewed and re-applied independently, per the architecture's
-- own recommendation.
--
-- The mechanism: the API connects as "app_user", a role that does NOT own
-- any table (table owners bypass RLS by default in Postgres — this is why
-- a separate role is mandatory, not optional). Every table a customer's
-- data lives in gets a policy keyed off two session variables the API
-- sets with `SET LOCAL` at the start of each transaction:
--   app.user_id  — the authenticated user's uuid, or '' if unauthenticated
--   app.is_admin — 'on' for an admin request, unset/'off' otherwise
--
-- A forgotten `WHERE owner_id = ?` in application code, or a SQL
-- injection that reaches the database, still returns zero rows — the
-- database itself enforces isolation, not just the application layer.

-- ─────────────────────────────────────────────────────────────────
-- The application role. Dev-only password below (mirrors the docker-
-- compose Postgres service's own dev credentials); production deployments
-- must set this via the platform's secret manager and rotate it, never by
-- re-running this migration with a different literal.
-- ─────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN PASSWORD 'pxhost_app_dev';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- audit_logs is append-only at the database level, not just by
-- application convention (architecture doc 3.6): even a fully compromised
-- API process, or a bug in AuditService, cannot rewrite or erase history.
REVOKE UPDATE, DELETE ON "audit_logs" FROM app_user;

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END $$;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ─────────────────────────────────────────────────────────────────
-- Helper functions
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION current_app_user() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION current_app_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.is_admin', true) = 'on', false)
$$;

-- SECURITY DEFINER: runs with the privileges of the function's owner
-- (the migration role), so it can read `subusers` to answer "can this
-- user reach this server" even though the CALLER (app_user) will, once
-- this migration finishes, only be able to see subuser rows for servers
-- they already have access to — avoiding a chicken-and-egg dependency
-- between the servers policy and the subusers policy.
CREATE OR REPLACE FUNCTION can_access_server(p_server uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT current_app_is_admin()
      OR EXISTS (
           SELECT 1 FROM "servers" s
           WHERE s."id" = p_server AND s."owner_id" = current_app_user()
         )
      OR EXISTS (
           SELECT 1 FROM "subusers" su
           WHERE su."server_id" = p_server
             AND su."user_id" = current_app_user()
             AND su."accepted_at" IS NOT NULL
         )
$$;

-- ─────────────────────────────────────────────────────────────────
-- Policies. Every tenant-scoped table gets USING (can_access_server(...))
-- for SELECT/UPDATE/DELETE and WITH CHECK for INSERT/UPDATE, so a write
-- that would place a row outside what the current user can see is
-- rejected by the database, not just hidden from later reads.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE "servers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY servers_tenant ON "servers"
  USING (can_access_server("id"))
  WITH CHECK (current_app_is_admin() OR "owner_id" = current_app_user());

ALTER TABLE "backups" ENABLE ROW LEVEL SECURITY;
CREATE POLICY backups_tenant ON "backups" USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));

ALTER TABLE "databases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY databases_tenant ON "databases" USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));

ALTER TABLE "schedules" ENABLE ROW LEVEL SECURITY;
CREATE POLICY schedules_tenant ON "schedules" USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));

ALTER TABLE "server_variables" ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_variables_tenant ON "server_variables" USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));

ALTER TABLE "subusers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY subusers_tenant ON "subusers" USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));

ALTER TABLE "server_mounts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_mounts_tenant ON "server_mounts" USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));

ALTER TABLE "activity_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY activity_logs_tenant ON "activity_logs"
  USING (
    current_app_is_admin()
    OR "actor_id" = current_app_user()
    OR ("server_id" IS NOT NULL AND can_access_server("server_id"))
  )
  WITH CHECK (current_app_is_admin() OR "actor_id" = current_app_user());

ALTER TABLE "server_transfers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_transfers_tenant ON "server_transfers" USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));

ALTER TABLE "server_metrics_1m" ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_metrics_tenant ON "server_metrics_1m" USING (can_access_server("server_id"));

-- tasks has no server_id of its own; it joins through schedules.
ALTER TABLE "tasks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tasks_tenant ON "tasks"
  USING (
    EXISTS (
      SELECT 1 FROM "schedules" sc
      WHERE sc."id" = "tasks"."schedule_id" AND can_access_server(sc."server_id")
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "schedules" sc
      WHERE sc."id" = "tasks"."schedule_id" AND can_access_server(sc."server_id")
    )
  );

-- allocations are node infrastructure, not purely tenant data — a
-- customer needs to read their own server's allocation, but the pool of
-- free allocations on a node is an admin concern. Policy allows: admin
-- sees everything, everyone else sees only allocations bound to a server
-- they can access.
ALTER TABLE "allocations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY allocations_tenant ON "allocations"
  USING (current_app_is_admin() OR ("server_id" IS NOT NULL AND can_access_server("server_id")));

-- users, sessions, api_keys deliberately do NOT get RLS. Architecture doc
-- 2.4 scopes RLS to server-owned tenant data; identity/session tables are
-- a different concern with a hard chicken-and-egg problem if RLS were
-- applied here: login must look up a user BY EMAIL before any session
-- exists to set app.user_id from, and a users-table policy keyed on
-- current_app_user() would make that lookup return zero rows for every
-- login attempt. AuthService enforces "a user only ever touches their own
-- session/api-key rows" explicitly, in code, via `WHERE id = <the id from
-- their own verified JWT>` — the same pattern Prisma's own generated
-- queries already use throughout this module. app_user still has full
-- grants on these tables (see above); the boundary here is the
-- application layer, not the database, by design.
