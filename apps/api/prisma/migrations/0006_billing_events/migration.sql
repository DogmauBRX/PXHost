-- Milestone M14: billing hooks. billing_events.id is the EXTERNAL
-- payment provider's own event id (e.g. Stripe's "evt_..."), not a
-- generated uuid — an INSERT of an already-processed id violates this
-- primary key, which is the entire idempotency mechanism (architecture
-- doc roadmap M14: "idempotently suspends/restores"). See
-- BillingWebhookService's doc comment.

CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "server_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "raw_payload" JSONB NOT NULL,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_action_check"
  CHECK ("action" IN ('suspend', 'restore'));

ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "billing_events_server_id_idx" ON "billing_events"("server_id", "received_at" DESC);

-- Not RLS-protected: billing events are processed by the webhook
-- handler under an admin-equivalent context (the payment provider is
-- authenticated by HMAC signature, not a user session), same posture as
-- server_transfers' own admin-driven writes.
