-- Asaas becomes the default payment provider. Nothing existing is
-- dropped or renamed — legacy Mercado Pago rows (provider =
-- 'mercadopago') stay exactly as they are, for financial history.

-- ─────────────────────────────────────────────────────────────────
-- 1. New rows default to the new provider. Existing rows untouched.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "orders" ALTER COLUMN "provider" SET DEFAULT 'asaas';
ALTER TABLE "payment_webhook_events" ALTER COLUMN "provider" SET DEFAULT 'asaas';

-- ─────────────────────────────────────────────────────────────────
-- 2. payments_status_check hard-coded Mercado Pago's own 9-value
--    vocabulary (0022_payments: "never a provider-specific value the
--    platform invented" — true then, but that vocabulary itself WAS
--    Mercado-Pago-specific). Asaas's payment statuses are a disjoint
--    set (PENDING, RECEIVED, CONFIRMED, OVERDUE, REFUNDED, ...) and a
--    future third provider would be disjoint again — a closed enum
--    CHECK here would need editing on every provider this platform
--    ever adds, which is exactly the per-provider coupling
--    PAYMENT_PROVIDER exists to avoid. Replaced with a much looser
--    guard: never null, never empty. `PaymentsService.recordFromGateway`
--    (application code) is the real validation — it only ever writes a
--    status that `AsaasProvider`'s own status map produced.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "payments" DROP CONSTRAINT "payments_status_check";
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_check" CHECK (length("status") > 0);

-- ─────────────────────────────────────────────────────────────────
-- 3. Cancel-at-period-end (payments plan §19) — the subscription stays
--    active/past_due (server keeps running) until billing-cycle finds
--    currentPeriodEndsAt has passed, then finishes the cancellation
--    instead of generating a renewal order. Default false: an
--    IMMEDIATE cancel (the only kind that existed before this) is
--    unaffected.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "subscriptions" ADD COLUMN "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false;
