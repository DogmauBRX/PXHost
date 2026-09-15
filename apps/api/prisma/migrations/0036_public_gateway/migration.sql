-- Public-exposure plan: nodes are residential/CGNAT, so a customer's game
-- traffic is proxied through a VPS gateway over the WireGuard tunnel that
-- already exists (deploy/vps/wg0.conf.example). Purely additive — with no
-- Gateway row configured, PublicRoute is never created and every existing
-- read path (ip:port shown to the customer) is untouched.

-- AlterTable
ALTER TABLE "nodes" ADD COLUMN "tunnel_ip" INET;

-- CreateTable
CREATE TABLE "gateways" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "public_host" TEXT NOT NULL,
    "tunnel_ip" INET NOT NULL,
    "control_url" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_applied_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "gateways_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public_routes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "gateway_id" UUID NOT NULL,
    "server_id" UUID NOT NULL,
    "public_port" INTEGER NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'tcp',
    "state" TEXT NOT NULL DEFAULT 'pending',
    "last_error" TEXT,
    "applied_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "public_routes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "public_routes_server_id_key" ON "public_routes"("server_id");
CREATE UNIQUE INDEX "public_routes_gateway_id_public_port_key" ON "public_routes"("gateway_id", "public_port");
CREATE INDEX "public_routes_state_idx" ON "public_routes"("state");

ALTER TABLE "public_routes" ADD CONSTRAINT "public_routes_state_check"
  CHECK ("state" IN ('pending', 'active', 'failed', 'removing'));

ALTER TABLE "public_routes" ADD CONSTRAINT "public_routes_gateway_id_fkey"
  FOREIGN KEY ("gateway_id") REFERENCES "gateways"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public_routes" ADD CONSTRAINT "public_routes_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: gateways is pure admin infrastructure (same posture as "nodes" —
-- never read outside an admin/isAdmin context, so no policy needed).
-- public_routes IS customer-visible (a server's own public address), same
-- shape as backups_tenant/databases_tenant/schedules_tenant in
-- 0002_rls_policies: admin sees everything, a customer sees only their own
-- server's route.
ALTER TABLE "public_routes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_routes_tenant ON "public_routes"
  USING (can_access_server("server_id"))
  WITH CHECK (can_access_server("server_id"));
