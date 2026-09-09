-- Mercado Pago (Checkout Pro) integration, payments plan step 2 — the
-- platform's OWN commercial/financial tables. Nothing here is
-- provider-specific in shape: `orders` is the pedido (what was bought,
-- at what price, in what state, and what it should provision once
-- paid), `payments` is one gateway transaction against an order (an
-- order can have several — a Pix that expired, then a card that was
-- charged), and `payment_webhook_events` is delivery/idempotency
-- bookkeeping for inbound notifications. This migration adds schema
-- only — no route reads or writes any of it yet, so the existing
-- suite must stay green unmodified.

-- ─────────────────────────────────────────────────────────────────
-- 1. orders — the commercial pedido, tenant-owned (RLS below).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE "orders" (
    "id"                     UUID NOT NULL DEFAULT uuidv7(),
    "external_reference"     TEXT NOT NULL,
    "user_id"                UUID NOT NULL,
    "plan_id"                UUID NOT NULL,
    "subscription_id"        UUID,
    "server_id"              UUID,
    "kind"                   TEXT NOT NULL DEFAULT 'plan_initial',
    "amount_cents"           INTEGER NOT NULL,
    "currency"               CHAR(3) NOT NULL,
    "status"                 TEXT NOT NULL DEFAULT 'pending',
    "provider"               TEXT NOT NULL DEFAULT 'mercadopago',
    "external_preference_id" TEXT,
    "checkout_url"           TEXT,
    "payment_method"         TEXT,
    "installments"           INTEGER,
    "paid_amount_cents"      INTEGER,
    "paid_at"                TIMESTAMPTZ,
    "expires_at"             TIMESTAMPTZ,
    "provisioning_status"    TEXT NOT NULL DEFAULT 'not_required',
    "provisioning_error"     TEXT,
    "provisioning_attempts"  INTEGER NOT NULL DEFAULT 0,
    "config"                 JSONB NOT NULL,
    "created_at"             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"             TIMESTAMPTZ NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_kind_check"
  CHECK ("kind" IN ('plan_initial','plan_renewal','addon'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check"
  CHECK ("status" IN ('pending','paid','failed','cancelled','refunded','expired'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_provisioning_status_check"
  CHECK ("provisioning_status" IN ('not_required','pending','running','done','failed'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_amount_cents_check" CHECK ("amount_cents" >= 0);

-- The webhook's ONLY lookup key (payments plan's own rule: never accept
-- a notification just because amount/product name happen to match).
-- Server-generated, never accepted from the client.
CREATE UNIQUE INDEX "orders_external_reference_key" ON "orders"("external_reference");
-- At most one order ever provisions a given server — the actual
-- idempotency guard ProvisioningService relies on (a retry sees this
-- already set and no-ops instead of provisioning twice).
CREATE UNIQUE INDEX "orders_server_id_key" ON "orders"("server_id");

CREATE INDEX "orders_user_id_status_idx" ON "orders"("user_id", "status");
CREATE INDEX "orders_status_idx" ON "orders"("status");
CREATE INDEX "orders_subscription_id_idx" ON "orders"("subscription_id");
CREATE INDEX "orders_external_preference_id_idx" ON "orders"("external_preference_id");

ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- 2. payments — one gateway transaction per row. `id` is the PROVIDER's
--    own payment id used verbatim as the primary key (same doctrine as
--    the existing placeholder `billing_events.id`, 0006_billing_events):
--    a webhook redelivering the same payment hits a real unique-
--    constraint violation on insert, which IS the idempotency guard.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE "payments" (
    "id"                    TEXT NOT NULL,
    "order_id"              UUID NOT NULL,
    "status"                TEXT NOT NULL,
    "status_detail"         TEXT,
    "amount_cents"          INTEGER NOT NULL,
    "paid_amount_cents"     INTEGER,
    "currency"              CHAR(3) NOT NULL,
    "payment_method_id"     TEXT,
    "payment_type_id"       TEXT,
    "installments"          INTEGER,
    "approved_at"           TIMESTAMPTZ,
    "refunded_amount_cents" INTEGER NOT NULL DEFAULT 0,
    "raw"                   JSONB NOT NULL,
    "created_at"            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"            TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- The 9 statuses Mercado Pago's own docs enumerate for a payment
-- (checkout-api/response-handling/collection-results) — never a
-- provider-specific value the platform invented.
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_check"
  CHECK ("status" IN ('pending','approved','authorized','in_process','in_mediation','rejected','cancelled','refunded','charged_back'));

CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");
CREATE INDEX "payments_status_idx" ON "payments"("status");

-- RESTRICT, not CASCADE: financial history is permanent (payments plan's
-- own repeated rule) — an order can never be deleted out from under a
-- payment record. See the REVOKE DELETE below for the same rule enforced
-- against accidental application-level deletes too.
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- 3. payment_webhook_events — delivery/idempotency bookkeeping for
--    inbound notifications. `id` is the notification's own id (same
--    PK-as-idempotency-key doctrine as payments.id above): Mercado
--    Pago retries an unacknowledged notification every 15 minutes
--    (its own documented policy) — a redelivery hits a duplicate-key
--    error on insert and is treated as already-received, never
--    reprocessed.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE "payment_webhook_events" (
    "id"           TEXT NOT NULL,
    "provider"     TEXT NOT NULL DEFAULT 'mercadopago',
    "type"         TEXT NOT NULL,
    "action"       TEXT,
    "data_id"      TEXT,
    "order_id"     UUID,
    "status"       TEXT NOT NULL DEFAULT 'received',
    "error"        TEXT,
    "raw"          JSONB NOT NULL,
    "received_at"  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_status_check"
  CHECK ("status" IN ('received','processed','ignored','failed'));

CREATE INDEX "payment_webhook_events_order_id_idx" ON "payment_webhook_events"("order_id");

ALTER TABLE "payment_webhook_events" ADD CONSTRAINT "payment_webhook_events_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────
-- 4. Financial history is never deleted (payments plan's own repeated
--    rule) — enforced at the database level, not just by omitting a
--    DELETE endpoint. UPDATE stays granted: a payment's status/refund
--    amount and an order's status/provisioning fields legitimately
--    change over their lifecycle.
-- ─────────────────────────────────────────────────────────────────
REVOKE DELETE ON "orders" FROM app_user;
REVOKE DELETE ON "payments" FROM app_user;
REVOKE DELETE ON "payment_webhook_events" FROM app_user;

-- ─────────────────────────────────────────────────────────────────
-- 5. Row-Level Security — `orders` only, same tenant-owned pattern as
--    `subscriptions` (0014_subscriptions): a customer must only ever
--    see their own orders. `payments`/`payment_webhook_events` are
--    deliberately NOT RLS-protected, same posture 0006_billing_events
--    already documents for `billing_events`: both are written and read
--    exclusively by the webhook handler and admin routes, which always
--    run under an admin-equivalent RLS context (the payment provider is
--    authenticated by its own signature, not a user session) — there is
--    no code path where a customer's own JWT context queries either
--    table directly. A customer's view of their payment history goes
--    through `orders` (and its `payments` relation, loaded under that
--    same admin-equivalent context on the customer's behalf), never a
--    direct query against `payments`.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_tenant ON "orders"
  USING (current_app_is_admin() OR "user_id" = current_app_user())
  WITH CHECK (current_app_is_admin() OR "user_id" = current_app_user());
