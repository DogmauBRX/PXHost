-- Closes a real gap found auditing the payments module before the Asaas
-- migration: ServersService.unsuspend() was UNCONDITIONAL — nothing
-- distinguished a suspension billing-cycle applied for non-payment from
-- one an admin applied for abuse/ToS, so a recovered payment could
-- silently undo an administrative suspension. `suspension_source` is
-- the discriminator; unsuspend() (application code, not this migration)
-- is updated to refuse reactivating a server whose suspension_source
-- isn't 'billing' when called from the billing path.
--
-- Existing suspended rows are backfilled 'admin' — every suspension in
-- this database predates the billing-suspension feature (the live
-- Mercado Pago webhook never called suspend/unsuspend; only the
-- separate BillingModule placeholder and the admin controller did), so
-- 'admin' is the only honest default for data that already exists.

ALTER TABLE "servers" ADD COLUMN "suspension_source" TEXT;

UPDATE "servers" SET "suspension_source" = 'admin' WHERE "status" = 'suspended';

ALTER TABLE "servers" ADD CONSTRAINT "servers_suspension_source_check"
  CHECK ("suspension_source" IS NULL OR "suspension_source" IN ('admin', 'billing'));

-- Mirrors the existing servers_suspension_consistency CHECK between
-- status and suspended_at (0001_init) — suspension_source must be set
-- exactly when the server actually is suspended, never orphaned.
ALTER TABLE "servers" ADD CONSTRAINT "servers_suspension_source_consistency_check"
  CHECK (("status" = 'suspended') = ("suspension_source" IS NOT NULL));
