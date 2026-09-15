-- Custom hostname plan: a customer-chosen, DNS-label-shaped identifier
-- ("survival") composed with PUBLIC_GATEWAY_HOSTNAME_ZONE at read/reconcile
-- time into "${label}.${zone}" (public-address.ts's deriveCustomHostname) --
-- directly under the apex, NOT nested under the existing
-- "${shortId}.mc.${zone}" wildcard scheme (public-address.ts's
-- deriveHostname), which stays untouched. Nullable + globally UNIQUE (not
-- per-owner): Postgres allows multiple NULLs under a UNIQUE index (same
-- pattern already used by subscriptions.server_id), so no partial index is
-- needed, and global uniqueness is exactly what stops two different
-- customers from claiming the same address.
ALTER TABLE "public_routes" ADD COLUMN "custom_hostname" TEXT;
CREATE UNIQUE INDEX "public_routes_custom_hostname_key" ON "public_routes"("custom_hostname");

-- Bookkeeping only -- NEVER returned to a customer. Records the exact FQDN
-- (either "${label}.${zone}" or the legacy "${shortId}.mc.${zone}") DNS was
-- LAST successfully synced for, so GatewayService's reconciler can tell a
-- rename/clear/delete apart from "nothing changed" and remove the OLD
-- record instead of leaking it forever. NULL = DNS has never been
-- successfully synced for this route.
ALTER TABLE "public_routes" ADD COLUMN "dns_synced_hostname" TEXT;

-- No RLS change needed: public_routes_tenant (0036_public_gateway) already
-- covers every column on this table via can_access_server(); dns_synced_hostname
-- is simply never selected into any customer-facing Prisma query, the same
-- "column exists, app layer omits it" posture already used elsewhere.
