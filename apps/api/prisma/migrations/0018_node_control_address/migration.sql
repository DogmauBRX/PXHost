-- Deploy plan (VPS + Cloudflare + WireGuard) — lets the panel reach a
-- node's control-plane API on a different origin than the one the
-- browser uses. NULL (every existing node) means "same as fqdn/scheme/
-- daemonPort" — AgentClientService.baseURL falls back exactly as it
-- always has. Only an admin explicitly setting this (e.g. to the node's
-- WireGuard tunnel address) changes anything.
ALTER TABLE "nodes" ADD COLUMN "control_address" TEXT;
