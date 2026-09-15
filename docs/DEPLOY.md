# Deploy: VPS + Cloudflare + nodes via WireGuard

This is the operational runbook for the topology decided in the
"Deploy em produção" plan: Cloudflare in front of a VPS running the
panel/API/datastores, connected over WireGuard to physical nodes that
each terminate their own public TLS for browser traffic (console, file
transfers, backups). See `../docs/ARCHITECTURE.md` §1 for the base
topology this extends, and `agent/README.md` for what the agent itself
does.

**Why nodes keep a public hostname instead of living entirely behind the
VPN:** the browser talks to the agent directly for console/file/backup
traffic (`apps/api/src/modules/nodes/agent-client.service.ts`'s
`wsUrl`/`fileTransferUrl` — "never proxied through this API"). WireGuard
only carries the panel↔agent *control plane* (create server, power
actions, heartbeat). Cloudflare's free plan also caps proxied request
bodies at 100MB, which would break large uploads/backup downloads if
routed through it — nodes are DNS-only (grey-clouded) there for exactly
this reason.

> **Node has no public IP (CGNAT/residential)?** Everything below through
> §3 step 4 (Caddy + its own DNS record) assumes the node CAN get a public
> hostname pointed at it, because the browser talks to the agent directly
> for console/file/backup traffic. A node behind CGNAT (no port forwarding
> possible) simply **skips Caddy and its DNS record** — it only needs the
> WireGuard spoke (§3 steps 2–3, 5–10; `controlAddress` is how the panel
> already reaches such a node today, unrelated to public IPs) — but then
> the browser-direct console/file/backup paths in §4 won't work for that
> node, since nothing terminates public TLS for it. Exposing a Minecraft
> **server's own game port** on a CGNAT node (so a player connects from the
> internet with no VPN and no router port forwarding) is a *separate,
> additive* concern from this whole document — see
> [`docs/PUBLIC-EXPOSURE.md`](./PUBLIC-EXPOSURE.md), which reuses the same
> WireGuard tunnel set up here but adds a VPS-side TCP gateway instead of
> relying on the node having any public address of its own.

## 1. DNS (Cloudflare)

| Record | Type | Proxy | Points to |
|---|---|---|---|
| `gxhost.com.br` | A | **Proxied** (orange) | VPS public IP |
| `api.gxhost.com.br` | A | **Proxied** (orange) | VPS public IP |
| `node01.gxhost.com.br` | A | **DNS only** (grey) | Node 01 (R620) public IP |
| `node02.gxhost.com.br` | A | **DNS only** (grey) | Node 02 (Dual Xeon) public IP |

Create a scoped API token (Zone → DNS → Edit, restricted to this zone)
for each node's Caddy to solve the DNS-01 ACME challenge — see
`deploy/node/Caddyfile`.

## 2. VPS setup

1. Install Docker + Docker Compose plugin, and WireGuard tools.
2. `git clone` this repo (or just copy `docker-compose.prod.yml`,
   `Caddyfile`, `apps/api/`, `apps/panel/` — the compose file's `build:`
   contexts need the app source trees present).
3. `cp .env.production.example .env` and fill in every value — see that
   file's own comments, especially the `app_user` password-rotation note.
4. WireGuard hub: copy `deploy/vps/wg0.conf.example` to
   `/etc/wireguard/wg0.conf`, generate a real key pair (`wg genkey | tee
   privatekey | wg pubkey > publickey`), fill in both node public keys
   once you have them (step 3 under Node setup), then
   `systemctl enable --now wg-quick@wg0`.
5. Bring up the datastores first, run migrations + seed, THEN start
   everything else:
   ```bash
   docker compose -f docker-compose.prod.yml up -d postgres redis mariadb
   docker compose -f docker-compose.prod.yml run --rm api pnpm exec prisma migrate deploy
   # Rotate app_user's password now — see .env.production.example's comment
   # — then update DATABASE_URL in .env before continuing.
   docker compose -f docker-compose.prod.yml run --rm api pnpm exec prisma db seed
   docker compose -f docker-compose.prod.yml up -d
   ```
6. Confirm: `curl https://api.gxhost.com.br/healthz` and `/readyz` both
   report `database`/`redis` healthy; `https://gxhost.com.br` loads the
   panel.

## 3. Node setup (repeat per node)

1. Install Docker, WireGuard tools, and Caddy (with the
   `caddy-dns/cloudflare` module built in — the stock `caddy:2-alpine`
   image does not have it).
2. WireGuard spoke: copy `deploy/node/wg0.conf.example` to
   `/etc/wireguard/wg0.conf`, generate this node's key pair, fill in the
   VPS's public key/IP, set `Address` to `10.10.0.2/24` (node 01) or
   `10.10.0.3/24` (node 02). `systemctl enable --now wg-quick@wg0`, then
   add this node's public key to the VPS's `wg0.conf` and reload it
   there (`wg syncconf wg0 <(wg-quick strip wg0)`).
3. Firewall: edit the subnet/interface names in `deploy/node/firewall.sh`
   if they differ, then run it as root. This is what actually keeps port
   8443 off the public internet — the agent itself listens on
   `0.0.0.0:8443` (both loopback Caddy and the WireGuard peer need to
   reach it), so the firewall is the only thing enforcing the split.
4. Caddy: copy `deploy/node/Caddyfile`, replace `node0X.gxhost.com.br`
   with this node's real hostname, set `CLOUDFLARE_API_TOKEN` in its
   environment, start it (systemd unit or your distro's Caddy service).
5. Agent: build `GOOS=linux GOARCH=amd64 go build ./cmd/pxagent` (or use
   a release binary), install to `/usr/local/bin/pxagent`. Copy
   `deploy/node/node.json.example` to `/etc/gxhost-agent/node.json` and
   fill in the real paths/values (data dirs, `panel_public_key_path` —
   the same Ed25519 public key `PANEL_ED25519_PRIVATE_KEY` in the VPS's
   `.env` corresponds to). Copy the seccomp profile
   (`agent/configs/seccomp-gxhost.json`) alongside it.
6. From the panel (Nodes → Novo node), create the node row: `fqdn =
   node0X.gxhost.com.br`, `scheme = https`, `daemonPort = 443` (the
   PUBLIC target, what the browser uses). Copy the bootstrap token it
   gives you.
7. On the node: `pxagent bootstrap --panel https://api.gxhost.com.br
   --token <bootstrap-token> --node /etc/gxhost-agent/node.json` — this
   writes `node_uuid`/`node_token`/`panel_url` into `node.json`.
8. Install and start the agent service: copy `deploy/node/pxagent.service`
   to `/etc/systemd/system/`, `systemctl daemon-reload && systemctl
   enable --now pxagent`.
9. Back in the panel, edit this node and set **Endereço de controle**
   to its WireGuard address, e.g. `http://10.10.0.2:8443` (node 01) or
   `http://10.10.0.3:8443` (node 02) — this is what makes
   `AgentClientService` reach it over the VPN instead of the public
   hostname, per `Node.controlAddress`'s own doc comment in
   `apps/api/prisma/schema.prisma`. Leaving this blank would still work
   (it falls back to the public address) but defeats the point of the
   VPN for the control plane.
10. Confirm the node shows `online` in the panel within ~15s (the
    heartbeat interval) and hardware telemetry appears.

## 4. Verification checklist

1. `docker compose -f docker-compose.prod.yml ps` — every service
   healthy; `/healthz` and `/readyz` on the API report ok.
2. Login on `https://gxhost.com.br` works, and a page refresh doesn't
   log you out (silent refresh across `gxhost.com.br` ↔
   `api.gxhost.com.br`, same registrable domain).
3. `wg show` on the VPS shows a recent handshake with both nodes; `curl
   http://10.10.0.2:8443/healthz` from the VPS succeeds.
4. Node health is `online` in the panel; hardware telemetry (CPU model,
   memory, disk) is populated.
5. The three browser-direct paths, which are the entire reason for this
   topology: open a server's console (WSS connects), upload and download
   a file **larger than 100MB** (proves it isn't going through
   Cloudflare's proxy), download a backup.
6. From outside the VPN, `curl https://node0X.gxhost.com.br:8443` (or
   any direct hit on 8443 from a non-loopback, non-WireGuard address)
   must fail/time out, while `https://node0X.gxhost.com.br` (443) responds
   — confirms the firewall split is actually in effect.
7. Audit log entries show the real client IP, not the Caddy/Cloudflare
   proxy's address (confirms Fastify's `trustProxy` is working —
   `apps/api/src/main.ts`).

## 5. Ongoing operations

- **Backups:** `pg_dump` the `postgres` container on a schedule, with
  retention, and copy offsite — nothing in this stack does this
  automatically yet. Game-server backups already live on each node's
  own disk, outside the bind-mounted server tree (`agent/README.md`
  §4.5) — worth an offsite copy too, not yet wired up.
- **Token rotation:** `token_rotation_interval_hours` is set to `168`
  (weekly) in `deploy/node/node.json.example` — the agent rotates its
  own control token on that schedule once running (`pxagent serve`'s own
  doc comment); `pxagent rotate-token` is available for a manual/offline
  rotation too.
- **Redeploying after a code change:** `docker compose -f
  docker-compose.prod.yml build api worker panel && docker compose -f
  docker-compose.prod.yml up -d`. Run `prisma migrate deploy` (the same
  one-shot `run --rm api ...` as initial setup) BEFORE swapping the
  running containers if the change includes a migration.
