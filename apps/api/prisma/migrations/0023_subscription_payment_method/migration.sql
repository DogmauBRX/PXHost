-- Recurring card billing + Pix-by-period, both as payment methods of
-- the SAME Subscription (payments plan, "assinatura recorrente"
-- follow-up). Nothing here changes behavior for an existing
-- subscription — every new column is nullable or defaults to the
-- current (Pix/manual-renewal) behavior.

ALTER TABLE "subscriptions" ADD COLUMN "payment_method" TEXT;
-- The Mercado Pago preapproval id — card-only. This is the ONLY key the
-- webhook is allowed to look a subscription up by for
-- subscription_preapproval/subscription_authorized_payment events (same
-- "never match on amount or name" doctrine external_reference already
-- follows for orders).
ALTER TABLE "subscriptions" ADD COLUMN "external_subscription_id" TEXT;
-- true once a card preapproval is authorized — billing-cycle reads this
-- to skip generating a renewal Order and skip the Pix-only 3-day
-- suspension timer: Mercado Pago's own retry/cancellation schedule is
-- authoritative for a card subscription, not ours.
ALTER TABLE "subscriptions" ADD COLUMN "auto_renew" BOOLEAN NOT NULL DEFAULT false;
-- The server is provisioned the moment a card subscription is
-- AUTHORIZED, deliberately before the first charge actually settles
-- (~1h later, Mercado Pago's own documented timing) — this flag is what
-- keeps "authorized" and "paid" from ever being conflated. Cleared the
-- moment the first invoice is approved; a rejected first invoice still
-- follows the normal past_due path, never a silent server teardown.
ALTER TABLE "subscriptions" ADD COLUMN "first_charge_pending" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payment_method_check"
  CHECK ("payment_method" IN ('pix', 'card') OR "payment_method" IS NULL);

CREATE UNIQUE INDEX "subscriptions_external_subscription_id_key" ON "subscriptions"("external_subscription_id");
