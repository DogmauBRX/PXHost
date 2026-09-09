-- Drops the "billing_events" table: it backed the generic, provider-
-- agnostic BillingModule placeholder (architecture doc roadmap M14),
-- which was itself removed once the real Asaas integration
-- (payment_webhook_events/payments, 0022_payments onward) replaced it as
-- the actual payment pipeline. No other table references "billing_events"
-- by foreign key, so no CASCADE is needed — same reasoning as
-- 0026_drop_backups_table.
DROP TABLE "billing_events";
