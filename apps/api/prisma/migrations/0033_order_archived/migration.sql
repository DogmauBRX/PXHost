-- Lets an admin hide an order from /admin/payments without touching
-- financial history. DELETE is revoked on this table (see 0002_rls_policies);
-- this column is the only supported way to "remove" an order from view.
ALTER TABLE "orders" ADD COLUMN "archived_at" TIMESTAMPTZ;
