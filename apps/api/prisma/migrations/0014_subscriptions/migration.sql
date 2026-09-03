-- Commercial site: subscriptions plan (see plan file for the full design
-- rationale). Adds the contract layer between a customer and a plan —
-- `subscriptions` — kept deliberately separate from `servers.plan_id`
-- (which exists purely for the snapshot-not-reference billing/drift
-- doctrine, architecture doc 2.1). Nothing here provisions a server;
-- `subscriptions.server_id` stays NULL for every row created by this
-- milestone (see the model's own doc comment in schema.prisma).

-- ─────────────────────────────────────────────────────────────────
-- 1. Commercial highlight on Plan (admin-picked, never algorithmic —
--    see Plan.isFeatured's doc comment in schema.prisma).
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "plans" ADD COLUMN "is_featured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "plans" ADD COLUMN "highlight_label" TEXT;

-- ─────────────────────────────────────────────────────────────────
-- 2. Bug fix found while building this feature: PlanCommercialFields
--    (plans/dto/plan.dto.ts) validates billingPeriod against
--    'monthly'|'quarterly'|'semiannual'|'annual', but the DB CHECK
--    added in 0001_init never included 'semiannual' — a plan saved
--    with that value passes DTO validation and then fails at the
--    database with an unreadable constraint violation. Widen the
--    CHECK to match what the API already accepts; no existing row is
--    affected (none of the pre-existing values are removed).
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "plans" DROP CONSTRAINT "plans_billing_period_check";
ALTER TABLE "plans" ADD CONSTRAINT "plans_billing_period_check"
  CHECK ("billing_period" IN ('monthly','quarterly','semiannual','annual','none'));

-- ─────────────────────────────────────────────────────────────────
-- 3. subscriptions — the commercial contract itself.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE "subscriptions" (
    "id"                     UUID NOT NULL DEFAULT uuidv7(),
    "user_id"                UUID NOT NULL,
    "plan_id"                UUID NOT NULL,
    "server_id"              UUID,
    "status"                 TEXT NOT NULL DEFAULT 'pending',
    "price_cents"            INTEGER NOT NULL,
    "currency"               CHAR(3) NOT NULL,
    "billing_period"         TEXT NOT NULL,
    "started_at"             TIMESTAMPTZ,
    "current_period_ends_at" TIMESTAMPTZ,
    "cancelled_at"           TIMESTAMPTZ,
    "cancel_reason"          TEXT,
    "created_at"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_status_check"
  CHECK ("status" IN ('pending','active','past_due','suspended','cancelled','expired'));

-- Same closed set the DTO validates ('monthly'|'quarterly'|'semiannual'|
-- 'annual') — a subscription is always priced with a real period, unlike
-- Plan.billingPeriod which additionally allows 'none' for a plan that
-- isn't sold on a recurring basis.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_period_check"
  CHECK ("billing_period" IN ('monthly','quarterly','semiannual','annual'));

-- One server serves at most one subscription (schema.prisma's own doc
-- comment on Server.subscription explains why this is unique, not just
-- indexed).
CREATE UNIQUE INDEX "subscriptions_server_id_key" ON "subscriptions"("server_id");

-- "my subscriptions, filtered by status" (client dashboard) and
-- "occupancy for this plan" (CapacityService.occupiedSlots) are the two
-- hot paths; "admin filters by status across everyone" is the third.
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");
CREATE INDEX "subscriptions_plan_id_status_idx" ON "subscriptions"("plan_id", "status");
CREATE INDEX "subscriptions_status_idx" ON "subscriptions"("status");

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- 4. subscription_events — append-only status history (admin's
--    "histórico básico"), same append-only spirit as audit_logs but
--    scoped per-subscription and readable by the owning customer too.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE "subscription_events" (
    "id"              BIGSERIAL NOT NULL,
    "subscription_id" UUID NOT NULL,
    "from_status"     TEXT,
    "to_status"       TEXT NOT NULL,
    "actor_id"        UUID,
    "reason"          TEXT,
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscription_events_subscription_id_idx" ON "subscription_events"("subscription_id");

ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- 5. Row-Level Security (0002_rls_policies' pattern: app_user is not
--    the table owner, so RLS is the real backstop, not defense in
--    depth). Both tables are tenant-owned — a customer must only ever
--    see their own subscriptions and their own events.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscriptions_tenant ON "subscriptions"
  USING (current_app_is_admin() OR "user_id" = current_app_user())
  WITH CHECK (current_app_is_admin() OR "user_id" = current_app_user());

-- WITH CHECK mirrors USING, not admin-only: a customer's own self-service
-- cancel (SubscriptionsService, written under the actor's OWN context —
-- see ActivityService.record's identical posture for activity_logs) must
-- be able to append its own history row, not just read it.
ALTER TABLE "subscription_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY subscription_events_tenant ON "subscription_events"
  USING (
    current_app_is_admin()
    OR EXISTS (
         SELECT 1 FROM "subscriptions" s
         WHERE s."id" = "subscription_events"."subscription_id"
           AND s."user_id" = current_app_user()
       )
  )
  WITH CHECK (
    current_app_is_admin()
    OR EXISTS (
         SELECT 1 FROM "subscriptions" s
         WHERE s."id" = "subscription_events"."subscription_id"
           AND s."user_id" = current_app_user()
       )
  );
