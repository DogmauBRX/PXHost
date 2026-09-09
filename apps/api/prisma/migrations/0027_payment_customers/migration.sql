-- Asaas migration, step 1 — links a User to their customer id on ONE
-- payment provider. Nothing provider-specific in shape: the same table
-- would host a Stripe/Pagar.me customer id later, keyed by `provider`.
-- Schema-only — no route reads or writes this yet.

CREATE TABLE "payment_customers" (
    "id"                   UUID NOT NULL DEFAULT uuidv7(),
    "user_id"              UUID NOT NULL,
    "provider"             TEXT NOT NULL,
    "external_customer_id" TEXT NOT NULL,
    "created_at"           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ NOT NULL,

    CONSTRAINT "payment_customers_pkey" PRIMARY KEY ("id")
);

-- At most one customer per (provider, user) — re-used across every
-- subscription/order that user ever creates, never re-created.
CREATE UNIQUE INDEX "payment_customers_provider_user_key" ON "payment_customers"("provider", "user_id");
-- The reverse lookup a reconciliation job needs (external id -> our user).
CREATE UNIQUE INDEX "payment_customers_provider_external_key" ON "payment_customers"("provider", "external_customer_id");

ALTER TABLE "payment_customers" ADD CONSTRAINT "payment_customers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Same "financial history is never deleted" rule 0022_payments already
-- applies to orders/payments/payment_webhook_events.
REVOKE DELETE ON "payment_customers" FROM app_user;

-- No RLS: written/read only by the webhook handler and OrdersService's
-- own admin-equivalent RLS context — same posture 0022_payments already
-- documents for `payments`/`payment_webhook_events`. There is no code
-- path where a customer's own JWT context queries this table directly.
