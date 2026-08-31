# PXHost Panel API

NestJS + Fastify + Prisma/PostgreSQL + Redis. See
[../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) section 3 for the
full design.

## Status: Admin/Client separation (multi-tenant platform split)

Goal: give the panel's new `/admin` vs `/client` split real backend teeth.
An investigation pass before any code changed confirmed the tenant
isolation itself was already correct — `ServerAccessService.resolve()`
plus the `can_access_server()` RLS policy already made "not yours" and
"doesn't exist" indistinguishable, and `AuthenticatedUser.isAdmin` was
already re-derived from the database every request, never trusted from
the JWT. What was missing was narrower: admin had no way to reach a
server it didn't own, no user CRUD existed at all, and no admin power
endpoint existed.

- **`ServerAccessService.resolve(userId, serverId, isAdmin = false)`** —
  new third parameter, defaulted so every pre-existing call site keeps
  behaving exactly as before. `isAdmin: true` takes an entirely separate
  path: fetches the server under `withRLS({ userId: null, isAdmin: true })`
  (the same admin RLS context `ServersService` has always used) and
  returns `role: 'admin'`, `can: () => true` — no `allowedWhenSuspended`
  gating, since inspecting/reviving a suspended server is exactly what an
  operator needs to do. The six services that call `resolve()`
  (`files`, `backups`, `schedules`, `databases`, `subusers`, `activity`,
  plus `client-servers`) were all updated to pass the caller's
  `AuthenticatedUser.isAdmin` through, and every `withRLS` call *internal*
  to those services that previously hardcoded `isAdmin: false` now uses
  `actor.isAdmin` too — resolving as admin but then re-querying a child
  row as a non-admin would silently RLS-filter it back to nothing.
  `schedule-runner.service.ts` (the cron dispatcher) deliberately builds
  a synthetic `{ id: ownerId, isAdmin: false }` actor instead — an
  unattended scheduled task must behave exactly like the owner clicking
  the same button, never with elevated access.
- **`subusers.service.ts`**'s three owner-only checks
  (`role !== 'owner'`) needed widening to `role !== 'owner' && role !==
  'admin'` — subuser management is intentionally restricted to the owner
  by a design decision from an earlier milestone, and an admin's resolved
  `role` from the change above is `'admin'`, not `'owner'`, so it would
  otherwise have been rejected by that specific check even with the
  `resolve()` bypass in place.
- **`activity.service.ts`.list()** had `isAdmin: false` hardcoded directly
  (its ownership check lives in the controller, not the service — a
  pre-existing inconsistency versus the other five modules, left as-is
  rather than refactored under this milestone's scope). Added an
  `isAdmin` parameter so an admin's activity-feed read actually reaches
  rows outside their own actor id.
- **New `UsersService.create/update/setActive`**, backing
  `POST /api/admin/users`, `PATCH /api/admin/users/:id`, and
  `POST /api/admin/users/:id/{block,unblock}` — this module was read-only
  by a deliberate prior-milestone scope cut, and had no create/edit/block
  path anywhere in the codebase, backend or frontend, despite being an
  explicit requirement. `create` hashes the password through the existing
  `PasswordService` (now exported from `AuthModule`) and pre-checks the
  partial unique indexes on `email`/`username` (`users_email_uq`,
  `users_username_uq` — both `WHERE deleted_at IS NULL`, not expressible
  as a Prisma `@unique`) before inserting, matching `LocationsService`'s
  existing pre-check style rather than catching a raw `P2002`. `setActive`
  needs no token-invalidation step to take effect: `JwtAuthGuard` already
  re-checks `isActive` fresh from the database on every request. Every
  method writes to the append-only `AuditService` under a distinct action
  name (`admin.user.create/update/block/unblock`) and every returned row
  goes through the same explicit `SAFE_SELECT` (never `passwordHash`,
  `totpSecretEnc`, or `recoveryCodesEnc`) the pre-existing `list()` method
  already established.
- Two additive `include` changes, no migration: `ServersService.list/get`
  now selects `owner: { id, username, email }` (the admin server-detail
  view had no client identity in it at all before this); `ServerAccessService
  .listAccessible` now selects `template` and `allocations` for the
  customer-facing server list.
- **No new admin-only power/files/backups/console-token routes.** Once
  the `resolve()` bypass existed, the pre-existing
  `/api/client/servers/:id/*` routes already worked for an admin caller —
  building a parallel admin surface for the same functionality would have
  been pure duplication. The panel's admin drill-down UI calls these same
  routes.

**Run for real, against the live stack (not mocked):** created two real
client accounts and one real server each via the running API, then
exercised the isolation boundary directly with `curl` bearer tokens for
each: client A got a genuine 404 from every one of client B's
resource routes (`GET .../B`, `POST .../B/console-token`,
`GET .../B/files`, `.../backups`, `POST .../B/power`, `.../schedules`,
`.../subusers`, `.../databases`, `.../activity`) and a genuine 403 from
every `/api/admin/*` route tried with client A's token
(`/servers`, `/users`, `/nodes`). The admin token got a real 200 from
every one of B's DB-backed resources through those *same* routes client
A was just denied on — direct, live confirmation that the bypass reaches
exactly the intended caller and no further. Created a user via the new
`POST /api/admin/users`, blocked them via `POST .../block`, then
attempted a real login with their password via `curl` — 401, immediately,
no stale session to clean up. Full suite run after every change in this
milestone, not just at the end: 44 unit tests and all 98 e2e specs green,
including `rls.e2e-spec.ts` and `client-servers.e2e-spec.ts` — both of
which exercise exactly the cross-tenant paths this milestone's changes
touch.

## Status: M14 — Billing hooks (final roadmap milestone; four real bugs found, all fixed)

Milestone DoD (architecture doc roadmap): **external payment event
idempotently suspends/restores a server.** Marked "(deferred)" — the
lowest-priority, last item on the roadmap — but its own wording presumes
a suspend/restore mechanism this codebase never actually had (see
`../../agent/README.md`'s matching section for the full gap this
investigation found before any billing-specific code was written): the
schema had `suspended_at`/`suspension_reason` columns since 0001_init,
architecture doc 2.5's gating table fully specified the rule, and NONE
of it was wired into `ServerAccessService.can()`. Building that real
mechanism is most of this milestone; the webhook itself is a thin layer
on top.

### Suspend / restore

- **`ServersService.suspend(id, reason, actorId)` /
  `unsuspend(id, actorId)`** — idempotent by construction (re-setting the
  same status is a harmless update), which is exactly what lets
  `BillingWebhookService` call these directly with no "is it already in
  that state" check of its own. `actorId` is nullable: a billing-driven
  suspension has no human actor, and `audit_logs.actor_id` is a real FK
  to `users` — passing a placeholder string here was a real mistake
  caught during development (not by a failing test — by re-reading the
  code before ever running it), documented in `suspend`'s own doc
  comment so it isn't repeated.
- **`ServerAccessService.can()`** gained the status gate architecture doc
  2.5's resolution order always specified ("... -> permission key ->
  server status gate -> ..."), applied to EVERY role including the
  owner — ownership answers "can you reach this server at all," not
  "does its current status allow this specific action." `allowedWhenSuspended()`
  encodes the gating table's own split (any `.read` key passes;
  `schedule.*` and a named list of control/file/backup/database
  mutating keys don't).
- **`AgentClient.setSuspended(nodeId, serverUuid, suspended)`** — the
  agent push, best-effort like every other post-commit dispatch in this
  service (the DB row, which `can()` gates on directly, is the real
  source of truth; a briefly-unreachable node just means the live
  container's teardown lags, not that the suspension itself is in
  doubt).
- Admin routes: `POST /api/admin/servers/:id/suspend { reason }`, `POST
  /api/admin/servers/:id/unsuspend`.

### Billing webhook

- **`src/modules/billing/`** (new) — `BillingWebhookService.handleEvent`
  maps a payment provider's event `type` to suspend/restore (a generic,
  Stripe-shaped vocabulary since the roadmap names no specific
  processor: `invoice.payment_failed`/`customer.subscription.deleted` →
  suspend, `invoice.payment_succeeded`/`customer.subscription.updated` →
  restore; anything else is a successful no-op, not an error — a webhook
  endpoint that 400s on every event type it doesn't act on trains the
  provider to disable the whole subscription). `BillingController`'s
  `POST /api/billing/webhook` is `@Public()` — a payment provider's own
  HMAC-SHA256 signature (`X-Signature: sha256=<hex>`, constant-time
  compared, same reasoning `auth.VerifyNodeToken` on the agent side
  already documents for the identical timing-attack concern) is this
  route's entire authentication.
- **Idempotency is the actual design center, not an afterthought**:
  `billing_events.id` IS the provider's own event id (`prisma/migrations/
  0006_billing_events`) — never a generated uuid. A redelivered event's
  `INSERT` hits that primary key and throws P2002, treated as "already
  processed" rather than an error. This isn't defending against a
  hypothetical: "the same event MAY be delivered more than once" is the
  literal, documented contract of every real webhook system, which is
  exactly what the DoD's own word "idempotently" is about.
- **`main.ts`** now boots with `bodyParser: false` and registers its own
  `application/json` content-type parser, capturing `req.rawBody`
  alongside Fastify's normal parsing — `BillingWebhookService` must
  verify the HMAC against the EXACT bytes the provider signed, not a
  re-serialized copy (re-serializing can silently reorder keys/whitespace
  and invalidate an otherwise-valid signature). Every other route ignores
  `req.rawBody` entirely.
- **`BILLING_WEBHOOK_SECRET`** is the one secret in this codebase that's
  genuinely optional (`env.schema.ts`) — unset means this deployment
  hasn't opted into billing hooks, and the endpoint fails closed (503 on
  every event) rather than ever accepting one it can't verify.

### Four real bugs found, all fixed

25. **A suspended server's freshly-minted console token still carried
    `websocket.connect`** — found live, the first real end-to-end test of
    the new status gate. The gate blocked every `control.*` permission by
    matching each key's OWN dotted prefix against a blocklist of GROUPS,
    but `websocket.connect`'s own key text starts with "websocket," not
    "control," even though `prisma/seed.ts`'s `PERMISSION_CATALOG` puts
    it in the `control` GROUP — a prefix check can never catch a key
    whose own text disagrees with its catalog group. Fixed by blocking
    the specific keys architecture doc 2.5 actually names, not a prefix
    guess (`websocket.connect` now listed explicitly alongside the other
    `control.*` keys).
26. **`ServersService.suspend`/`unsuspend` would have inserted an invalid
    UUID into `audit_logs.actor_id`** for every billing-driven
    call — caught reading the code back before ever running it, not by a
    failing test: `BillingWebhookService` has no human actor to pass, and
    a placeholder string like `"billing-webhook"` isn't a valid uuid for
    a real FK column. Fixed by making `actorId` nullable throughout
    (`string | null`), matching this codebase's existing convention for
    every other system-triggered audit entry (the M13 transfer callbacks
    already omit `actorId` entirely for the same reason).
27. **Nest's own default `application/json` body parser collided with a
    custom one** ("Content type parser 'application/json' already
    present") — `app.init()` registers Nest's default unconditionally;
    adding a second one for raw-body capture without first passing
    `{ bodyParser: false }` to `NestFactory.create`/`createNestApplication`
    fails immediately, in every environment (found first in this
    milestone's own e2e test, before it ever reached `main.ts`).
28. **The custom parser's `{ parseAs: 'buffer' }` mode hung Fastify's
    `light-my-request` (`app.inject()`) indefinitely** the moment a real
    e2e test tried to use it — no error, no timeout, just a stuck test
    run. `{ parseAs: 'string' }` (converting to a `Buffer` afterward for
    the actual signature check) resolved it outright; the real running
    server is unaffected either way, since real HTTP traffic doesn't go
    through `light-my-request` at all — this was purely a test-harness
    compatibility gap between Fastify's two body-parsing modes and how
    `inject()` feeds a payload.

**Run for real, full stack:** every piece above was exercised against a
real running node/agent — see `../../agent/README.md`'s M14 section for
the shared live-run narrative (the real force-kill, the two-layer WS
rejection proof, and two REAL signed webhook calls — computed with the
actual configured `BILLING_WEBHOOK_SECRET`, via plain `curl`, not the
test harness — that suspended and restored a live server in turn).
Regression: Go build/vet/test, this repo's `tsc`/44 unit tests/14
suites-98 e2e tests (`test/billing.e2e-spec.ts` is new, 7 tests including
a real duplicate-delivery idempotency proof), and the panel's `tsc`/build
all green afterward.

## Status: M13 — Hardening & operations (five real bugs found live; all fixed)

Milestone DoD (architecture doc roadmap): **live node-to-node transfer
with no data loss; token rotation; log partition automation.** This
milestone's own investigation surfaced a genuine, pre-existing gap
before any new code was written: `audit_logs`/`server_metrics_1m` were
always DOCUMENTED as RANGE-partitioned (this file's own schema comments)
but 0001_init actually created them as plain tables — Prisma's schema
DSL has no partitioning syntax, and the raw-SQL follow-up that was
supposed to convert them never landed. Closing that gap became this
milestone's third deliverable for real, not just on paper.

### Log partition automation

- **`prisma/migrations/0004_log_partitioning`** — converts both tables
  to real `PARTITION BY RANGE` parents (rename-copy-swap, since Postgres
  has no `ALTER TABLE ... PARTITION BY` for an existing table with real
  data — `audit_logs` had 1700+ rows from every earlier milestone's live
  testing, all preserved, verified via `tableoid` after the swap). Adds
  `ensure_future_partitions(months_ahead)` and
  `archive_old_metric_partitions(older_than_months)` — `SECURITY
  DEFINER`, so `app_user` (which has table-level DML grants but
  deliberately no schema-level `CREATE`) can still successfully create a
  new partition, the same reasoning `can_access_server()` already
  established in 0002_rls_policies. `audit_logs` gets NO archival
  function on purpose — see PartitionsService's doc comment: a security
  trail should never have code anywhere capable of making it shorter.
- **`src/modules/partitions/`** (new) — `PartitionsService` wraps the two
  SQL functions; `PartitionsController` exposes `GET
  /api/admin/partitions` (inventory) and `POST
  /api/admin/partitions/maintain` (manual trigger, same call the worker
  makes on its own schedule).
- **`src/queues/partition-maintenance.processor.ts`** (new) — a daily
  BullMQ repeatable job, same `upsertJobScheduler` shape every other
  repeatable job in this codebase already uses.

### Node-to-node transfer

- **`src/modules/transfers/`** (new) — `TransfersService.initiate()`
  mirrors `ServersService.create()`'s own shape almost exactly: an
  advisory-locked transaction does capacity check + target-allocation
  reservation (reusing `assertCapacity`/`pickFreeAllocation`, exported
  from `servers.service.ts` rather than reimplemented), sets
  `servers.status='transferring'`, then enqueues a `server-transfer`
  BullMQ job — the real byte-moving work happens off the request/response
  cycle, on the worker, for the same reason a backup job does.
  `runPipeline()` (worker-side) walks the DB's own status vocabulary
  (`pending→archiving→uploading→restoring→success|failed|cancelled` —
  the schema already encoded this exact pipeline shape before any of
  this milestone's code existed): stops the source, calls its
  `/transfer/export`, mints a `transfer.download` capability token,
  calls the target's `/transfer/import` with a URL+token for it to pull
  from. `RemoteTransfersController`'s `/api/remote/transfers/result`
  callback (called by the TARGET agent once its own async import
  finishes) does the actual finalization: moves `servers.node_id`,
  promotes the target allocation to primary and frees the source's, and
  — best-effort — tells the source agent to tear down its now-superseded
  copy.
- **`src/modules/nodes/agent-client.service.ts`** gained
  `exportTransfer`/`importTransfer`/`deleteTransferArchive`/
  `transferDownloadUrl`.

### Token rotation

- **`src/modules/nodes/node-bootstrap.service.ts`** gained
  `rotateSelf(nodeId)` (agent-initiated: revoke-then-create the new
  `node_tokens` row and update `nodes.control_token_enc` in ONE
  transaction — `node_tokens_one_active`'s partial unique index makes a
  real overlap window impossible even if this tried one, so the actual
  zero-downtime guarantee is "the response already carries the new token
  before the old one is dead") and `forceRotate(nodeId, actorId)` (the
  compromise-response path: immediately revoke, then issue a fresh
  bootstrap token via the SAME code path onboarding already uses — there
  is no way to hand a live credential to a node that might be the very
  thing being revoked FOR, so this deliberately doesn't try). New routes:
  `POST /api/remote/nodes/rotate-token` (agent self-rotation,
  `NodeAuthGuard`) and `POST /api/admin/nodes/:id/rotate-token`
  (admin-forced).

### Capability-token signing key rotation (JWKS)

- **New `signing_keys` table** (`prisma/migrations/0005_signing_keys`) —
  `current`/`retiring`/`retired` states, matching architecture doc 3.4's
  design; this implementation's one deliberate scope cut is that
  promotion is a single admin-triggered action (`rotate()` both
  generates AND promotes in one call) rather than the full doc's
  time-scheduled "published 24h ahead, promoted automatically, retired
  24h after" — the schema tracks `createdAt`/`promotedAt`/`retiredAt`
  separately regardless, so a future scheduled-promotion job is additive
  work, not a redesign.
- **`CapabilityTokenService`** rewritten around a DB-backed current key
  instead of solely the env-configured seed: on first boot (empty
  `signing_keys` table), it seeds one row FROM
  `PANEL_ED25519_PRIVATE_KEY` — an already-bootstrapped node's
  `panel_public_key_path` needs zero changes. Every mint now includes
  `kid` in the JWT header. `src/modules/security/` (new) —
  `SigningKeysService.rotate()`/`retire()`, `SigningKeysController`
  (admin), and `JwksController` — the genuinely public `GET
  /api/remote/jwks` agents fetch (no guard: a JWKS is public-key
  material by definition, and gating it on a node token would be
  circular).

### Five real bugs found live, all fixed

20. **BullMQ 6.x hard-rejects a custom `jobId` containing `:`**
    (`"Custom Id cannot contain :"`) — found the FIRST time
    `TransferQueueService.enqueue()` ever actually ran
    (`jobId: \`transfer:${id}\``). Investigating it turned up the exact
    same defect already latent in `schedule-tick.processor.ts`'s
    `jobId: \`schedule:${id}:${epoch}\`` — never triggered before because
    the schedules e2e suite calls `ScheduleRunnerService` directly, not
    through a real tick→dispatch enqueue. Both fixed: hyphens, not
    colons.
21. **`Prisma.$executeRaw` sends a bare JS number as `bigint`, not `int`**
    — `ensure_future_partitions(${monthsAhead})` failed with "function
    ... does not exist" against the SQL function's `int` parameter, the
    first time the worker's daily job actually ran it (the earlier raw
    `psql` testing during this same milestone's investigation never hit
    this — direct SQL doesn't go through Prisma's parameter binding).
    Fixed with an explicit `::int` cast at both call sites.
22. **The same two SQL functions failed under `app_user`** with
    "permission denied for schema public" until marked `SECURITY
    DEFINER` — `app_user` has table-level DML grants but no schema-level
    `CREATE`, so a genuinely NEW partition (not a no-op re-check of one
    that already existed) couldn't be created by the app's own runtime
    role. Caught by explicitly testing as `app_user`, not the migration
    owner, before trusting the earlier psql-as-superuser test that had
    silently masked it.
23. **`TransfersService.initiate()` left a server permanently stuck in
    `'transferring'`** if the post-commit `queue.enqueue()` call failed
    (which it did, live, because of bug #20) — the capacity-check
    transaction had already committed `transferring` + the reserved
    target allocation, and nothing reverted either. Manual SQL cleanup
    was needed to recover the live test the first time. Fixed with the
    same compensating-failure pattern `ServersService.dispatchToAgent`
    already uses for its own post-commit dispatch failure: a caught
    enqueue error now reverts the server to `ready` and frees the
    reservation before re-throwing.
24. **`AgentClient`'s flat 30-second HTTP timeout exactly matched the
    agent's own 30-second graceful-stop grace period** — a real `power
    stop` that legitimately took the full grace period to escalate
    through Docker's SIGTERM-then-SIGKILL sequence (reproduced live,
    repeatably, against a real container right after a Docker Desktop
    restart) raced the two timeouts and lost: the agent's stop was still
    genuinely succeeding server-side the instant this client gave up and
    reported a false failure. A `power stop` timing out is not a
    hypothetical edge case — waiting near the full grace period before
    escalating is exactly what that grace period is FOR. Fixed by
    raising the client timeout to 45s, comfortably longer than the
    ceiling it's racing.

**Run for real, full stack:** every piece above was exercised against
real Postgres, real Redis-backed BullMQ, two real independently-running
`pxagent` processes, and a real Docker Engine — see
`../../agent/README.md` for the shared live-run narrative (the transfer
pipeline, both token-rotation paths, and the JWKS round trip all ran
against this API, not a mock). Regression: Go build/vet/test, this
repo's `tsc`/43→44 unit tests/13 suites-91 e2e tests, and the panel's
`tsc`/build all green afterward.

## Status: M12 — Admin console (no new bugs; verified live end to end)

Milestone DoD (architecture doc roadmap): **onboard a new node and a new
game from the UI only; plan-apply dry run works.** Scoped to Panel + API,
but a dry-run-only "apply" would be a hollow admin feature, so this
milestone's "apply" is real: a DB snapshot update **and** a best-effort
live push to every affected server's agent (architecture doc 4.5), which
required a small, matching addition on the agent side (see
`../../agent/README.md`).

- **`src/modules/plans/plans.service.ts`** — rewritten around
  `DRIFTABLE_FIELDS` (every plan field a server snapshots at creation:
  cpu/memory/disk/swap/io-weight/pids/backup-quota/etc.) and
  `LIVE_RESOURCE_FIELDS` (the subset Docker's `ContainerUpdate` can
  actually change without a restart). `drift(planId)` compares the
  plan's current values against every server still on it and returns a
  `PlanDriftReport` (per-server, per-field before→after); `applyToServers
  (planId, actorId)` re-snapshots every drifted server's row, then for
  each one calls the new `AgentClient.updateLimits` (best-effort — a
  server whose node is offline still gets its DB row updated, just not
  the live container) and writes an audit log entry.
- **`src/modules/plans/plans.controller.ts`** — `GET :id/drift` (the
  dry run), `POST :id/apply` (drift + push, admin-gated like the rest of
  `/api/admin/*`).
- **`src/modules/plans/dto/plan.dto.ts`** — `UpdatePlanDto` extended to
  cover every resource field; it previously only accepted
  name/description/isPublic, a real pre-existing gap this milestone's DoD
  exposed (an admin literally could not edit a plan's resources through
  the API before this).
- **`src/modules/nodes/agent-client.service.ts`** — `updateLimits(nodeId,
  serverUuid, limits)`, a thin new call alongside the existing
  power/backup/file agent calls, `PATCH`ing the agent's new
  `/api/servers/{uuid}/limits`.

No new bug found this milestone — the drift/apply logic, the extended
`UpdatePlanDto`, and the new agent call all passed their e2e coverage
(`test/plans-apply.e2e-spec.ts`, 5 tests, real Postgres + a fake agent
HTTP server standing in for the node) on the first attempt, and the
subsequent full live run (below) exercised the real code path — real
Postgres, real Docker, a real compiled agent — without turning up
anything the e2e suite hadn't already caught.

**Run for real, full stack:** a brand-new location, node (bootstrapped
with a real token issued through this admin API), template group,
template, and plan were all created through the panel UI only — no
fixtures, no direct DB writes. A real server was provisioned onto the new
node and started (a real `alpine:3.19` container, confirmed running via
`docker inspect`). The plan's resources were then edited in the UI; `GET
:id/drift` correctly reported exactly one affected server with the real
before→after values; `POST :id/apply` was invoked from the UI's Apply
button and, per `docker inspect` immediately after, the **same running
container** (no restart) now carried the new memory and CPU limits — the
DB row and the live container agreed, and a follow-up dry run correctly
reported zero remaining drift. See `../../agent/README.md` for the
agent-side half of this same run (the actual `ContainerUpdate` call) and
`../panel/README.md` for the UI side.

## Status: M11 — Subusers, granular RBAC, activity feed

Milestone DoD (architecture doc roadmap): **invited friend can restart but
not delete backups; every mutation attributed in the feed.** This is the
first milestone where a non-owner can reach a server's routes at all —
every prior milestone's `ServerAccessService.resolve()` only ever
distinguished "owner" from "404," never "owner" from "this specific
narrower thing." New here:

- **`ServerAccessService.resolve()`** now returns a `can(permission)`
  closure alongside `{server, role}` (architecture doc 2.5's two-axis
  RBAC: RLS answers "can access this server at all," `can()` answers
  "can do THIS specific thing on it"). An owner's `can()` returns `true`
  unconditionally — ownership is the permission superset, never itself a
  stored grant. A subuser's resolves from `subusers.permissions`, cached
  in Redis at `perm:{user}:{server}` (60s TTL, invalidated immediately on
  invite/permission-update/removal — architecture doc 2.5's exact
  wording) on a SEPARATE logical Redis DB from `RedisService`'s own
  cache/denylist, matching M10's `QUEUE_REDIS_URL` precedent.
- **`SubusersModule`** (`src/modules/subusers`) —
  `/api/client/servers/:serverId/subusers` (owner-only invite/update/
  remove; invites auto-accept in v1, since nothing in the panel shows a
  pending-invite inbox yet) and `/api/client/permission-catalog` (the
  real seeded catalog — `websocket.connect`, `control.*`, `file.*`,
  `backup.*`, `database.*`, `schedule.*`, `user.*`, `activity.read` —
  the panel's checkbox UI renders directly from this, not a
  hand-maintained list).
- **`ActivityModule`** (`src/modules/activity`) — `activity_logs`
  (architecture doc 2.1: separate from the staff-facing `audit_logs`),
  written under `withRLS({userId: actorId})` so the table's own `WITH
  CHECK (actor_id = current_app_user())` enforces "attributed" at the
  database level, not just by application convention. Every existing
  mutating service (files, backups, databases, schedules, power) gained
  both a `can()` permission check AND an `activity.record()` call in
  this milestone — the retrofit touches five modules that predate RBAC
  entirely.
- **`permission_catalog` seed** (`prisma/seed.ts`) — 25 keys across 7
  groups, matching only what the panel actually implements (no
  `allocation.*`/`startup.*`/`settings.*` — nothing exists yet to gate).

### One real bug found (live, real browser, two real logged-in accounts)

19. **A WS-driven power action — the actual Reiniciar/Parar/Iniciar
    console buttons — never reached the activity feed at all**, only a
    REST-driven one did (nothing in the panel calls the REST `/power`
    endpoint directly; every power click goes over the console
    WebSocket). `ClientServersService.power()`'s new `activity.record()`
    call only fires on the REST path — the WS path is handled entirely
    inside the agent, which never talked to this API for anything but
    install-completion and heartbeats before this milestone. Found live:
    invited a real second account, watched its real restart click
    actually restart the real Docker container, then found the activity
    feed showed only the owner's earlier `server.power.start` — the
    friend's restart was simply invisible. Fixed by giving the agent a
    new outbound call (`panel.ReportActivity`, see
    `../../agent/README.md` bug #17) and a matching inbound endpoint
    here: `POST /api/remote/servers/:uuid/activity` (`NodeAuthGuard`,
    same node-ownership double-check as the existing
    `install-completed` callback — a node's bearer token proves it's A
    node, not that it owns THIS server). Regression-tested in
    `servers.e2e-spec.ts` (the wrong-node-token case, mirroring the
    existing install-completed test) — the WS round-trip itself has no
    automated test, confirmed live instead, for the same
    `dockerFull`-isn't-mockable reason noted in the agent README.

**Run for real, full stack:** created two real user accounts, logged in
as the owner, invited the second account with `control.restart` +
`backup.read` but deliberately NOT `backup.delete` — exactly the DoD's
example. Logged in as the invited friend in the same real browser
(sequentially, not two tabs — the refresh cookie is shared per origin),
clicked the real Reiniciar button and watched the real Docker container
actually restart (confirmed via `docker inspect`'s `StartedAt`, not just
"no error shown"), then attempted to delete a real backup and got a real
`403` (confirmed both via the raw response and via the backup still
existing afterward). Read the activity feed as the owner afterward and
confirmed every single mutation above — the invite, the restart, a
backup delete the OWNER performed — was attributed to the correct actor,
not just "logged."

## Status: M10 — Schedules

Milestone DoD (architecture doc roadmap): **nightly restart+backup runs
unattended, respects timezone and node-offline skip, never double-fires.**
This is the first milestone to introduce background job processing at
all — every prior milestone's work happened synchronously in the request
path. New here:

- **`bullmq` + a separate worker process** (architecture doc 3.7/3.8) —
  `src/worker.ts` / `WorkerModule` is its own `NestFactory.
  createApplicationContext` (no HTTP listener), started via a new
  `pnpm start:worker` — the HTTP API process (`main.ts`/`AppModule`)
  never imports `QueuesModule`, so it never starts consuming jobs itself.
  `QUEUE_REDIS_URL` is a separate logical Redis DB from `RedisService`'s
  cache/denylist.
- **`ScheduleTickProcessor`** — a single BullMQ repeatable job
  (`upsertJobScheduler`, every 30s) that runs `SELECT id FROM schedules
  WHERE is_active AND NOT is_processing AND next_run_at <= now() FOR
  UPDATE SKIP LOCKED` inside a real transaction, claims what it finds
  (`is_processing = true`), and hands each one to `schedule-dispatch`
  with a deterministic `jobId` (`schedule:<id>:<plannedRunAtEpoch>`).
  Two independent no-double-fire guarantees, not one: BullMQ's own
  repeat mechanism ensures exactly one worker processes each tick
  occurrence, and `FOR UPDATE SKIP LOCKED` means two concurrent ticks
  (even across worker processes) can never both claim the same due
  schedule — proven directly against real Postgres in
  `schedules.e2e-spec.ts`, not asserted against a mock.
- **`ScheduleRunnerService.run()`** — the actual execution, called by
  `ScheduleDispatchProcessor`'s job handler. Deliberately reuses
  `ClientServersService.power` and `BackupsService.create` rather than
  calling `AgentClient` directly, so an unattended nightly run behaves
  EXACTLY like a customer clicking the same buttons (same quota checks,
  same audit trail). `onlyWhenOnline` skips the entire run — no agent
  call at all — when the node's `healthStatus` is `offline`. Always
  clears `is_processing` and recomputes `nextRunAt` in a `finally`-style
  path, even on failure or skip, so a schedule can never get stuck
  claimed or silently stop advancing.
- **`SchedulesModule`** (`src/modules/schedules`) — `/api/client/servers/
  :serverId/schedules` CRUD + `/:scheduleId/tasks` sub-resource,
  `maxSchedules` quota enforced the same way M9's `maxDatabases` is.
  `computeNextRunAt` uses `cron-parser` (real 5-field cron grammar +
  IANA timezone), rejecting an unparseable schedule at create/update time
  rather than storing one that could never fire.

### Two real findings this milestone (both caught before anything shipped, by the project's own tests — worth documenting anyway)

17. **`tasks.action` and `schedules.last_run_status` both carry real
    Postgres CHECK constraints from `migrations/0001_init` — set when
    this project's schema was first designed, long before M10 wrote any
    code against them — and this milestone's first draft invented its
    own vocabulary (`'power:restart'`/`'backup:create'`,
    `'skipped_offline'`/`'skipped_inactive'`) that didn't match either
    one. `tasks_action_check` actually allows
    `('command','power','backup','delete_files')` — `action` and
    `payload` are separate columns for a reason: `action='power'` +
    `payload='restart'`, not a single compound string — and
    `schedules_last_run_status_check` allows only `('success','failed',
    'skipped')`, a single generic `'skipped'` for every skip reason, not
    a specific one per cause. Every write attempt failed with a raw `23514
    check constraint` Postgres error (500) the instant `schedules.e2e-
    spec.ts` tried to add a task — caught immediately, before any of this
    reached a browser. Fixed by reading the actual migration SQL instead
    of inventing an API shape, then aligning `TASK_ACTIONS`,
    `CreateTaskDto`, `SchedulesService.addTask`, and
    `ScheduleRunnerService`'s status writes to the real vocabulary.
18. **`AgentClient.call()`'s `ConflictException`/`ServiceUnavailableException`
    mapping (M8 bug #14) already made this milestone's live-testing catch
    a genuine, pre-existing AGENT bug** — see `../../agent/README.md` bug
    #16 (`Server.Stop` leaving state stuck at `"stopping"` forever on a
    timed-out stop). Not an API-side bug itself, but found only because
    this milestone's live run drove a real unattended restart end to end
    rather than stopping at "the HTTP call returned some status code."

**Run for real, full stack:** started a real worker process
(`pnpm start:worker`) alongside a real bootstrapped node/agent, created a
real schedule with `backup`+`power` tasks, forced `next_run_at` into the
past, and watched the real 30-second tick claim and dispatch it — the
backup task produced a real `.tar.gz`+`.json` pair on the agent's disk,
confirmed by reading the directory directly, not just trusting
`lastRunStatus`. Separately proved `onlyWhenOnline`: marked the node
`offline`, forced another due run, and confirmed the worker log itself
said `skipped: node offline` with zero new agent HTTP requests. Also
verified, against the REAL running server (not `app.inject()`): an
invalid cron field and an invalid task action both correctly return
`400` — `schedules.e2e-spec.ts` cannot assert either of those directly,
per the same known Fastify `app.inject()`/class-validator gap under
`--experimental-vm-modules` documented in `client-servers.e2e-spec.ts`.

## Status: M9 — Databases (API + Panel; no agent-side work this milestone)

Milestone DoD (architecture doc roadmap): **plugin connects with created
credentials; server deletion drops the schema+user.** Both proven live
against a REAL MariaDB container (`docker-compose.dev.yml`'s new
`mariadb` service) — this milestone is the first to have the panel talk
directly to an external service the Node Agent never touches at all.

- **`DatabasesModule`** (`src/modules/databases`) — `DatabaseHostsController`
  (`/api/admin/database-hosts`, admin CRUD: create tests the connection
  against the real host BEFORE persisting anything, so a typo'd password
  fails at admin-input time, not at a customer's first database create)
  and `DatabasesController` (`/api/client/servers/:serverId/databases`,
  ownership resolved via `ServerAccessService` like every other
  client-facing surface): list/create/delete.
- **`MysqlHostClient`** — the actual `mysql2` connections. Every DDL
  statement's identifiers (database name, username) are SERVER-generated
  and allowlist-regex-checked right before use (`^[a-z0-9_]{1,64}$`) since
  MySQL has no placeholder syntax for identifiers, only values — the
  password IS bound as a real placeholder (`IDENTIFIED BY ?`). One
  short-lived connection per operation, no pooling — provisioning is an
  infrequent admin/create-time operation, not a request-path hot path.
- **`DatabasesService.create`** generates `s<server.shortId>_<suffix>`
  (suffix customer-chosen, validated `^[a-z0-9_]{1,32}$`, defaulting to
  `db`) and a random `u<shortId><hex>` username, picks the least-loaded
  host with room under its own admin-set `maxDatabases` cap (mirrors the
  node auto-deploy spread, architecture doc 2.6 — never bin-packs), and
  returns the plaintext password EXACTLY ONCE, like a bootstrap token —
  only the AES-256-GCM-encrypted form persists. If the metadata `INSERT`
  fails after the real schema+user already exist on the host, they're
  dropped again before the error propagates — never leaves an orphaned,
  uncredentialed MySQL account behind.
- **`ServersService.remove`** — server deletion didn't exist in this
  codebase before this milestone (every earlier milestone only ever
  CREATED servers). Order matters: the agent's real container teardown
  must SUCCEED first (architecture doc 2.2 — "hard-deleted once the
  agent confirms teardown" is not negotiable), then each database is
  dropped on its real host (best-effort — one unreachable host must never
  block the rest of the teardown, but every failure is audit-logged, not
  silently lost), then the server row is hard-deleted (never soft — a
  ghost row would inflate disk/allocation quotas forever). Self-service
  deletion stays off by default (architecture doc 9.4); this is the
  admin/automation path (`DELETE /api/admin/servers/:id`).

### Two real bugs found (one live in the browser, one caught by the e2e suite before it ever reached one)

15. **`databases` is RLS-protected (`can_access_server`), and four
    separate places in this milestone's own new code queried it through a
    PLAIN `this.prisma.database...` call instead of the mandatory
    `withRLS` chokepoint** — `DatabaseHostsService.remove`'s in-use guard,
    `DatabaseHostsService.list`'s per-host database count, and
    `DatabasesService`'s `generateUniqueUsername` collision check and
    `pickHostWithCapacity`'s load-spread count. Every one of these ran
    with no `app.user_id`/`app.is_admin` session variable set, so RLS
    silently treated the caller as anonymous and filtered out EVERY row
    — not an error, just always an empty result. Concretely: the in-use
    guard always reported "not in use" even with active databases,
    letting `admin database-host CRUD: cannot delete a host that still
    has databases in use` fail with a `204` instead of the expected
    `409` the very first time `databases.e2e-spec.ts` ran. The other
    three are the identical bug with less visible symptoms (a uniqueness
    check that always "passes" because it never sees existing rows; a
    load-spread that never actually spreads because every host always
    looks empty) — found by auditing every `this.prisma.database`/
    `this.prisma.databaseHost` call in the new module once the first one
    turned up, not independently. `PrismaService`'s own doc comment says
    this exact thing — "even one already authorized by a guard — MUST go
    through this" — and this milestone's first draft is the case study
    for why.
16. **`server.maxBackups` (snapshotted from the plan at creation time,
    same mechanism this milestone's `maxDatabases` check uses) was never
    actually enforced in M8's `BackupsService.create`** — a customer
    could create unlimited backups regardless of their plan's limit.
    Found while writing this milestone's `maxDatabases` quota check side
    by side with M8's backup code and noticing the equivalent check was
    simply missing. Fixed in `backups.service.ts`, not re-tested live in
    a browser (M8's live run already covered backup creation UX; this is
    a pure server-side quard) — covered by the existing e2e suite's
    capacity-check pattern.

**Run for real, full stack:** registered a real MariaDB host (the new
`docker-compose.dev.yml` service) via the admin API, bootstrapped a real
node/agent, created a real server, created a database from the PANEL UI
(the credentials panel — database, username, password, host:port — shown
exactly once), then connected with those EXACT credentials from an
independent `mariadb` client (not the panel, not root) and ran real
DDL/DML against the real schema. Deleted the database via the API and
confirmed the same credentials were rejected (`Access denied`) — not just
that the metadata row was gone. Created a second database, then deleted
the SERVER via `DELETE /api/admin/servers/:id` and confirmed, independent
of any API response: the Docker container gone from `docker ps -a`, the
real MySQL schema gone from `SHOW DATABASES`, and the server row itself
returning `404`.

## Status: M8 — Backups (API side)

The API-side half of M8 (agent side in `../../agent/README.md`, panel UI
in `../panel/README.md`). New here:

- **`BackupsModule`** (`src/modules/backups`) — `BackupsController` at
  `/api/client/servers/:serverId/backups`: list/create/delete/restore,
  every one resolving ownership via `ServerAccessService.resolve()` first
  (same chokepoint M6 established), plus `POST .../{id}/download-link`
  minting a single-use `backup.download` capability token the browser
  hits directly on the agent — same "this API never proxies the actual
  bytes" posture as M7's file transfers.
- **`AgentClient`** gained `listBackups`/`createBackup`/`deleteBackup`/
  `restoreBackup`/`backupDownloadUrl`.
- **`CapabilityTokenService`** — `Capability` extended with
  `'backup.download'`.

### One real bug found (live, real browser — restore-while-running never actually surfaced its 409)

14. **`AgentClient.call()` collapsed EVERY non-2xx response from the
    agent into a generic `503 Service Unavailable`**, including a
    deliberate, well-formed `409` the agent sends specifically so a
    caller can act on it (`srv.ErrServerNotStopped` — "stop the server,
    then retry"). `BackupsService.restore()` has no special-case error
    handling of its own; it just awaits `AgentClient.restoreBackup()` and
    lets whatever it throws propagate. The panel's `BackupsPage.tsx` was
    already written to special-case `err.status === 409` with a friendly
    Portuguese message — but since every agent error arrived as `503`,
    that branch was DEAD CODE from the moment it was written, and a real
    "restore while running" click showed the raw agent JSON
    (`Agent returned 409: {"error":{"code":"SERVER_NOT_STOPPED",...`)
    instead. Confirmed live: attempted a restore against a server the
    panel itself showed as `RUNNING` and watched the raw-text error
    render; fixed `agent-client.service.ts`'s `call()` (both the JSON and
    raw-body variants) to throw `ConflictException` specifically for a
    `409` agent response instead of folding it into the generic
    `ServiceUnavailableException` path; re-ran the exact same
    click-restore-while-running flow in the same browser tab after the
    API hot-reloaded and confirmed the friendly message now renders.
    Regression-tested in `test/backups.e2e-spec.ts` against a real local
    HTTP server standing in for the agent (not a mock of `AgentClient`
    itself — the point is proving the real `fetch()` response-handling
    path). This fix is generic to `call()`, not backups-specific — it
    also corrected an equivalent pre-existing bug in the `power` action's
    "already offline"/"already stopping" conflict responses, discovered
    as a side effect while re-testing the fix (previously also a bare
    `503`).

**Run for real, full stack:** created a real server against a real
bootstrapped node, edited a file, created a backup, modified the file,
attempted restore while running (409, confirmed both via raw `curl` and
in the browser), stopped the server, restored again (success, confirmed
via `AgentClient`'s 204 and by reading the restored file's content
straight off the agent's disk), minted and used a real signed backup
download link. See `../../agent/README.md` and `../panel/README.md` for
the rest of this run.

## Status: M7 — File manager (API side)

The API-side half of M7 (agent side in `../../agent/README.md`, panel UI
in `../panel/README.md`). New here:

- **`FilesModule`** (`src/modules/files`) — `FilesController` at
  `/api/client/servers/:serverId/files`: list/read/write/rename/delete/
  mkdir/chmod/compress/decompress, every one resolving ownership via
  `ServerAccessService.resolve()` before proxying to `AgentClient`, plus
  `POST .../download-link` and `POST .../upload-link` minting a
  single-path-scoped, single-use Ed25519 capability token the BROWSER
  then hits directly on the agent — this API never proxies the actual
  file bytes.
- **`AgentClient`** gained `listFiles`/`readFile`/`writeFile`/
  `renameFile`/`deleteFile`/`mkdir`/`chmod`/`compress`/`decompress` and a
  new `callRaw` path (the agent's write endpoint takes the file's raw
  bytes as the body, not JSON) plus `fileTransferUrl`.
- **`CapabilityTokenService.mint`** — `cap` was HARDCODED to `"ws"` in
  M6, the only capability that existed then; now takes `cap` and an
  optional `ctx: {path, maxBytes}`, matching `AgentCapabilityToken` from
  architecture doc 3.4 for real (console tokens now pass `cap: 'ws'`
  explicitly instead of relying on a default that no longer exists).

### One real bug found (live, real browser — not curl or `app.inject()`)

13. **Every cross-origin `PUT`/`PATCH`/`DELETE` from the panel's own
    origin was silently blocked, in every environment, since this API's
    CORS was first configured.** `app.enableCors({ origin, credentials,
    maxAge })` never set `methods` — `@fastify/cors`'s undocumented
    default (confirmed live via a raw `OPTIONS` request:
    `Access-Control-Allow-Methods: GET,HEAD,POST`) is narrower than its
    own README implies, covering only the methods the Fetch spec calls
    "simple" and exempts from a preflight in the first place. Every prior
    milestone's browser testing only ever needed GET/POST cross-origin —
    the file editor's `PUT .../files/contents` was the first real
    preflight this app ever triggered, and it failed outright with
    `Method PUT is not allowed by Access-Control-Allow-Methods in
    preflight response`. Fixed by setting `methods` explicitly to the
    six verbs this API actually uses. Same lesson as M6's `__Host-`
    cookie bug: `curl`/`app.inject()` don't enforce CORS or cookie-prefix
    rules at all, so an entire category of real-browser-only bug can hide
    behind a fully green e2e suite indefinitely.

## Status: M6 — Panel MVP support

The API-side half of M6 (the panel itself lives in `../panel`, see its
own README for the full milestone writeup — login → list → start →
console → command → live stats, run for real in a browser). New here:

- **`AuthorizationModule` (`ServerAccessService`)** — the single
  chokepoint every client-facing server route goes through
  (architecture doc 5.1). `resolve(userId, serverId)` runs under
  `withRLS` with the CALLER's own (non-admin) context, so
  `servers_tenant`'s policy (`can_access_server`) is what actually
  decides access — a non-owner and a nonexistent server both 404
  identically, never confirming existence to someone who can't see it.
- **`ClientServersController`** (`/api/client/servers`) — the owner's own
  view: list/get their servers, `POST :id/power` (proxies to
  `AgentClient.power`), `POST :id/console-token` (mints the capability
  token the browser uses to connect directly to the agent's WS).
- **`CapabilityTokenService`** (`src/core`) — mints the Ed25519-signed
  capability token agent/internal/auth.Claims verifies fully offline.
  Signs a raw compact JWS with Node's built-in `crypto` (no JWT library
  dependency — `jose` v5 is ESM-only and this repo's build is CommonJS,
  which bit `@fastify/cookie` already; avoided the same trap here).
  `PANEL_ED25519_PRIVATE_KEY` reuses the exact keypair
  `agent/hack/smoketest/keys` already has, so an already-bootstrapped
  node's `panel_public_key_path` needs no changes.

### One real bug found (the live browser run in `../panel`'s README)

12. **The refresh cookie's `Set-Cookie` header was silently dropped by
    every real browser, in dev AND production** — `__Host-panel_refresh`
    combined with `Path=/api/auth` violates the `__Host-` prefix's own
    requirement (`Path=/`, no exceptions), so the browser never actually
    stored it. `curl` and Fastify's `app.inject()` don't enforce
    cookie-prefix rules, which is exactly why this passed every e2e test
    since M3 — only a real browser's cookie jar, exercised for the first
    time in this milestone, could have caught it. Fixed in
    `auth.controller.ts` by switching to `__Secure-panel_refresh` (which
    only requires the `Secure` attribute, not a specific path) and always
    setting `Secure: true` — browsers treat `http://localhost` as a
    secure context for this purpose, so local dev is unaffected.

## Status: M5 — Dynamic server provisioning

Builds on M4 (below). New in M5:

- **`ServersModule`** (`src/modules/servers`) — the create transaction
  (architecture doc 2.6/4.4): validates owner/template/plan, takes a
  `pg_advisory_xact_lock` on the node so two concurrent creates can never
  both pass the same capacity check, sums existing usage, enforces a
  memory/disk ceiling (`(total - reserved) * (1 + overallocate%)`; CPU is
  deliberately never capacity-checked — it's time-shared), reserves a free
  allocation via `SELECT ... FOR UPDATE SKIP LOCKED`, snapshots the plan's
  limits onto the new `servers` row, and resolves template variables. Only
  after that transaction commits does it dispatch to the agent — a slow or
  unreachable agent can never hold the node's capacity lock. A dispatch
  failure marks the row `install_failed` (audited), never leaves it stuck.
  `POST /api/remote/servers/:uuid/install-completed` (agent-only,
  `NodeAuthGuard`) moves a server to `ready`/`install_failed`.
- **`PlansModule`** (`src/modules/plans`) — admin CRUD for hosting plans,
  slug-uniqueness check, in-use guard on delete.
- **`AgentClient`** (`src/modules/nodes/agent-client.service.ts`) — the
  panel's one outbound client to a node agent's control API
  (`POST/DELETE /api/servers`), authenticating with the same node-token
  secret issued at bootstrap, now also kept panel-side as
  `nodes.control_token_enc` (AES-256-GCM, explicit key version) — an
  interim shared-secret design pending full mTLS, documented at length on
  that column in `schema.prisma`.
- **The Go agent now provisions containers for real**: `POST
  /api/servers` builds the env/spec, pulls, creates, and runs an install
  container (`agent/internal/srv/install.go`,
  `agent/internal/spec/install.go`), then calls back to
  `/api/remote/servers/:uuid/install-completed` — see
  `../../agent/README.md`.

**Run for real, full stack, not just each side in isolation:** a real
node was created and bootstrapped exactly like M4, then a real
`POST /api/admin/servers` was fired at this real running panel — which
took the advisory lock, checked capacity, reserved a real allocation,
committed the transaction, and dispatched over real HTTP to the real
compiled `pxagent` binary. The agent pulled `alpine:3.19` for real,
created the game server container, ran a real install container that
wrote a file to the real bind-mounted persistent volume, and called back
`/api/remote/servers/:uuid/install-completed` — the panel flipped the row
to `status: "ready"` with a real `installedAt`. This first end-to-end
attempt failed twice before succeeding, and both failures were real bugs
(#10 and #11 below), not environment noise — each was root-caused from
the actual Docker daemon error, fixed, and re-run against the same live
stack until the file showed up on disk. See `../../agent/README.md` for
the agent-side half of this run and bug #11.

### Five more real bugs found

7. **The agent's install-completed callback always 404'd, even for the
   correct node.** `ServersService.reportInstallResult` read `servers`
   (an RLS-protected table) via the plain, non-`withRLS` Prisma client —
   see the now-corrected doc comment on `PrismaService` for why that reads
   as zero rows, not an error. The guard's own defense-in-depth check
   (`server.nodeId === callingNode.id`) never even ran; the lookup itself
   already failed. Fixed by wrapping the read+update in a single
   `withRLS({ isAdmin: true }, ...)` transaction. Caught by
   `servers.e2e-spec.ts`'s callback test, which also asserts a *different*
   node's token is correctly refused (404 for the right reason now).
8. **Three separate "in-use" delete guards were dead code.** `PlansService
   .remove`, `NodesService.remove`, and `TemplatesService.removeTemplate`
   each check `server.count({ where: { planId/nodeId/templateId } }) > 0`
   before allowing a soft-delete — all three via the same plain,
   non-`withRLS` client, so the count was always `0` and the guard never
   fired. Since these are soft deletes (`deleted_at`), there's no FK
   constraint to catch the mistake at the database level either — a
   plan/node/template actively in use by a server could be silently
   deleted. Fixed the same way as #7; regression-tested in
   `servers.e2e-spec.ts` by creating a server and asserting all three
   deletes now return 409.
9. **The `PrismaService` doc comment itself was wrong**, and it's what led
   to bugs 7 and 8: it claimed direct `this.<model>` calls "connect as the
   migration/superuser role and bypass RLS." In fact `DATABASE_URL`
   connects as `app_user` — the same RLS-restricted role `withRLS` uses —
   so a direct call on an RLS-protected table isn't a bypass, it's a
   silent zero-rows filter. Rewritten to state plainly which tables have
   no RLS policy at all (safe direct) versus which do (must go through
   `withRLS`, always).
10. **The first live create dispatch failed outright** — the real Go
    agent's Docker daemon rejected container creation:
    `ParseAddr("203.0.113.50/32"): unexpected character (at "/32")`.
    `pickFreeAllocation`'s raw SQL cast the allocation's `inet` column with
    `ip::text`, and Postgres's `inet` type carries an implicit `/32` host
    netmask — `::text` renders it inline, so the panel was handing the
    agent `"203.0.113.50/32"` as a bare IP address for Docker's port
    bindings, every single time, for every server ever created. Would
    never have been caught by any test using a mocked agent — only a real
    Docker daemon parses (and rejects) the string. Fixed by casting with
    `host(ip)` instead, which returns just the address. Neither unit tests
    nor the e2e suite could catch this (they never call a real agent); it
    surfaced only because this milestone's verification includes an actual
    live cross-language run.

Bugs 7–9 were caught by the live e2e suite against real Postgres; bug 10
was caught only by the live cross-language run against a real Docker
daemon — a reminder that RLS/logic bugs and infrastructure-contract bugs
need different kinds of "real" to surface.

7. **The agent's install-completed callback always 404'd, even for the
   correct node.** `ServersService.reportInstallResult` read `servers`
   (an RLS-protected table) via the plain, non-`withRLS` Prisma client —
   see the now-corrected doc comment on `PrismaService` for why that reads
   as zero rows, not an error. The guard's own defense-in-depth check
   (`server.nodeId === callingNode.id`) never even ran; the lookup itself
   already failed. Fixed by wrapping the read+update in a single
   `withRLS({ isAdmin: true }, ...)` transaction. Caught by
   `servers.e2e-spec.ts`'s callback test, which also asserts a *different*
   node's token is correctly refused (404 for the right reason now).
8. **Three separate "in-use" delete guards were dead code.** `PlansService
   .remove`, `NodesService.remove`, and `TemplatesService.removeTemplate`
   each check `server.count({ where: { planId/nodeId/templateId } }) > 0`
   before allowing a soft-delete — all three via the same plain,
   non-`withRLS` client, so the count was always `0` and the guard never
   fired. Since these are soft deletes (`deleted_at`), there's no FK
   constraint to catch the mistake at the database level either — a
   plan/node/template actively in use by a server could be silently
   deleted. Fixed the same way as #7; regression-tested in
   `servers.e2e-spec.ts` by creating a server and asserting all three
   deletes now return 409.
9. **The `PrismaService` doc comment itself was wrong**, and it's what led
   to bugs 7 and 8: it claimed direct `this.<model>` calls "connect as the
   migration/superuser role and bypass RLS." In fact `DATABASE_URL`
   connects as `app_user` — the same RLS-restricted role `withRLS` uses —
   so a direct call on an RLS-protected table isn't a bypass, it's a
   silent zero-rows filter. Rewritten to state plainly which tables have
   no RLS policy at all (safe direct) versus which do (must go through
   `withRLS`, always).

The create-transaction and concurrency-race tests themselves — the
milestone's actual DoD — passed on the first real run against Postgres;
these three were found while building out the surrounding test coverage
(the in-use-guard regression test in particular was added *because* bug 7
raised the question "where else does this pattern exist").

## Status: M4 — Infrastructure catalog

Builds on M3 (below). New in M4:

- **Nodes/Locations/Allocations** (`src/modules/nodes`, `src/modules/locations`) —
  full admin CRUD, plus the **real node provisioning handshake**
  (architecture doc 4.2/7): `POST /api/admin/nodes/:id/bootstrap-token`
  issues a single-use, 30-minute, Redis-backed token; the agent redeems it
  at `POST /api/remote/nodes/bootstrap` for a long-lived, argon2id-hashed
  node token; `POST /api/remote/nodes/heartbeat` (guarded by
  `NodeAuthGuard`, never a user JWT) keeps the node's health live.
  `deriveHealthStatus` computes online/degraded/offline/unknown from
  `last_heartbeat_at` at **read** time rather than trusting a possibly-stale
  stored column. Allocation range import (`POST .../allocations`) bulk-creates
  a port range, skipping already-existing ports, capped at 1000/request.
- **Templates/eggs** (`src/modules/templates`) — nests (`template_groups`)
  and eggs (`server_templates` + `template_variables`) CRUD, with
  server-side validation that a variable's `envVariable` matches the Go
  agent's own `^[A-Z][A-Z0-9_]{0,63}$` allowlist regex — an admin cannot
  save a template whose variable would be silently dropped the moment a
  server actually starts. Seeded with a real Paper (Minecraft) template
  and install script (`prisma/seed.ts`).
- **`AdminGuard`** — coarse `global_role`-based gate for every
  `/api/admin/*` route (fine-grained `admin.*` permission strings are a
  later milestone).
- **The Go agent now speaks this API for real**: `pxagent bootstrap
  --panel <url> --token <bootstrap-token> --node node.json` redeems a
  bootstrap token and writes `node_uuid`/`node_token`/`panel_url` into
  node.json; `pxagent serve` then heartbeats to the panel on a fixed
  interval for as long as it runs (`agent/internal/panel`,
  `agent/cmd/pxagent/bootstrap.go`). **This was run for real** — see
  `../../agent/README.md` for the live run's output (a real node created
  in the admin API, a real bootstrap token, the real compiled `pxagent`
  binary redeeming it against this real server backed by real Postgres,
  heartbeating until the node showed `healthStatus: "online"` with the
  actual local Docker Engine version reported).

### Two more real bugs found

5. **`JSON.stringify` cannot serialize `BigInt`, and several PKs in this
   schema are `BigInt`** (`template_variables.id`, `allocations.id`,
   `activity_logs.id`, `audit_logs.id`) — the very first endpoint that
   returned one (`POST /api/admin/eggs` with variables) crashed with a 500
   the moment the live e2e suite exercised it. Fixed globally via a
   `BigInt.prototype.toJSON` polyfill (`src/core/bigint-json.polyfill.ts`),
   imported once at the top of `app.module.ts` so it runs before any
   controller in both the real server and every e2e test — mapping each
   BigInt to a string in every individual response would have been the
   same fix repeated (and eventually forgotten) at every call site.
6. **`AllocationsService` wrote to an RLS-enabled table with no RLS
   context** — the exact same class of bug as M3's RLS-policy-vs-write
   issue, except this time in real service code, not a test fixture:
   `allocations` has a policy scoped to
   `current_app_is_admin() OR (server_id IS NOT NULL AND
   can_access_server(server_id))`, and a freshly-imported allocation has
   `server_id IS NULL` — so with no RLS context set at all, the policy's
   `USING` clause (reused for the write check absent an explicit `WITH
   CHECK`) evaluates to false unconditionally, and `createRange` failed
   outright the moment the live nodes e2e suite imported a real port
   range. Fixed by wrapping every method in `withRLS({ isAdmin: true },
   ...)` — correct, not a workaround, since every route reaching this
   service is already `AdminGuard`-gated. Also caught, while investigating:
   the same read-side gap would have hidden unassigned allocations
   (`server_id IS NULL`) from an admin's own allocation-pool view.

Both were caught by the live e2e suites against the real Postgres — the
same mechanism that caught bugs 1–4 in M3.

## Status: M3 — Data foundation + identity

What exists today:

- **Full v1 schema** ([prisma/schema.prisma](prisma/schema.prisma)) — every
  table from architecture doc section 2: identity, infrastructure, catalog,
  servers, server services, observability. Two migrations:
  - `prisma/migrations/0001_init` — all tables, plus (hand-added, since
    Prisma's schema DSL can't express these) the `uuidv7()` shim function,
    status `CHECK` constraints, soft-delete-aware partial unique indexes,
    the owner-cannot-be-a-subuser trigger, and hot-path indexes.
  - `prisma/migrations/0002_rls_policies` — Row-Level Security. Creates
    the restricted `app_user` role, enables RLS on every server-owned
    table (`servers`, `backups`, `databases`, `schedules`,
    `server_variables`, `subusers`, `server_mounts`, `activity_logs`,
    `server_transfers`, `server_metrics_1m`, `tasks`, `allocations`), and
    makes `audit_logs` append-only at the database level (a trigger
    rejects `UPDATE`/`DELETE` outright, not just a `REVOKE`).
- **Two-connection privilege split**: `DATABASE_URL` (what the running API
  actually connects as) points at `app_user`, which does **not** own any
  table and is therefore always subject to RLS. `DIRECT_DATABASE_URL`
  (owner role) is used only by `prisma migrate`. This is load-bearing —
  see "a real bug found" below.
- `PrismaService.withRLS(ctx, fn)` — runs `fn` inside a transaction with
  `SET LOCAL app.user_id` / `app.is_admin`, which the RLS policies read.
  Every server-scoped query in the codebase must go through this (or
  through `ServerAccessService`, which already does).
- `ServerAccessService.resolve(userId, serverUuid)` — the sole chokepoint
  for reaching a server: owner / accepted-subuser / admin, 404 (never 403)
  for anyone else, backed by RLS as the enforcement layer, not just the
  `if` statement.
- **Auth module**: argon2id passwords (uniform-timing dummy-verify against
  account enumeration, rehash-on-drift), HS512 access tokens (15 min) +
  opaque refresh tokens (14 days, SHA-256-hashed at rest, `HttpOnly
  Secure SameSite=Lax __Host-` cookie), refresh **rotation with reuse
  detection** (presenting an already-used refresh token revokes the whole
  session family), a global `JwtAuthGuard` (default-deny, `@Public()`
  opt-out) checking both a Redis denylist and `tokens_valid_after`.
- **AuditService** — writes synchronously in the request path (never a
  background queue, for the events that matter: login, login failure,
  refresh reuse, logout).
- **CryptoService** — AES-256-GCM envelope encryption with per-record AAD
  binding and **explicit, operator-incremented key versioning**
  (`APP_KEY_VERSION`) — see "bugs found" below for why this matters.
- `GET /healthz` (liveness, no dependency checks) and `GET /readyz`
  (checks Postgres + Redis independently).
- `prisma/seed.ts` — idempotent root admin seed (`pnpm prisma:seed`).

Not yet implemented (later milestones): 2FA/TOTP, personal API keys,
servers/nodes/plans CRUD, the panel↔agent trust model (mTLS, node tokens,
Ed25519 capability tokens — that side is already built in the Go agent,
see `../../agent`), BullMQ queues, rate limiting.

## Real bugs found while building and verifying this milestone

1. **Key-rotation version collision in `CryptoService`.** The original
   implementation tagged every ciphertext with a hardcoded `v1` regardless
   of which real-world key generation produced it. After a rotation
   (`APP_KEY` replaced, old key moved to `APP_KEY_PREVIOUS`), old and new
   ciphertexts became indistinguishable by tag — decrypting an old record
   with the rotated-in service failed outright, because "version 1" now
   pointed at the new key. Fixed by introducing `APP_KEY_VERSION`, an
   explicit, operator-incremented counter; caught by
   `crypto.service.spec.ts`'s rotation test, which encrypts with one
   version and asserts it's still readable after "rotating" to a second.
2. **RLS on `users`/`sessions`/`api_keys` breaks login** (design-time
   catch, before it ever ran): if those tables had RLS scoped to
   `id = current_app_user()`, login's own "find the user by email" query —
   which by definition runs *before* any `app.user_id` exists to set —
   would always return zero rows. Architecture doc 2.4 only ever scoped
   RLS to server-owned tables; identity/session tables intentionally have
   **no RLS** and rely on the application layer (`WHERE id = <verified JWT
   subject>`, the same pattern Prisma already generates) instead.
3. **`tokensValidAfter` comparison rejected freshly-issued tokens** (found
   running the e2e suite for real): JWT `iat` has whole-second resolution;
   `tokensValidAfter` is millisecond-precision. A token minted in the same
   wall-clock second as a `tokensValidAfter` bump (e.g. right after a
   refresh-reuse event forces a fresh login) could have `iat*1000` round
   down below `tokensValidAfter`'s sub-second component even though the
   token was genuinely issued afterward — the guard rejected a completely
   valid, brand-new token. Fixed by flooring `tokensValidAfter` to the
   second before comparing; regression-tested in `jwt-auth.guard.spec.ts`
   with a token minted in the exact same second as the bump.
4. **Hard-deleting a user with audit history is refused, by design
   collision, not oversight.** `audit_logs.actor_id` is
   `ON DELETE SET NULL`, but `audit_logs` is also append-only via a
   trigger that rejects *any* `UPDATE` — including the one the `SET NULL`
   FK action itself performs. Deleting a user who has ever logged in (i.e.
   every real user) via a hard `DELETE FROM users` is therefore refused
   outright by the same guarantee that protects the trail from tampering.
   This isn't a bug to silently fix — `users` already has the
   soft-delete (`deleted_at`) pattern for exactly this reason, and no
   application code hard-deletes a user today. It's flagged here because a
   future account-erasure feature (GDPR-style) will hit this exact
   conflict and needs a deliberate decision (e.g. a narrower trigger that
   permits only the FK's own `SET NULL`), not a surprise in production.

All four were caught by, respectively: a unit test written for the
scenario, careful reading before the code ever ran, the live e2e suite
against a real Postgres, and the live e2e suite's cleanup step.

## Local setup

```
docker compose -f ../../docker-compose.dev.yml up -d   # Postgres + Redis
cp .env.example .env                                    # then fill in APP_KEY / JWT_SESSION_SECRET
pnpm install
pnpm prisma:migrate:deploy   # runs both migrations via DIRECT_DATABASE_URL (owner role)
pnpm prisma:seed             # root admin: admin@pxhost.local / ChangeMe!23456 (override via env)
pnpm start:dev
```

Generate `APP_KEY` / `JWT_SESSION_SECRET`:
```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Testing

```
pnpm test        # unit — no external dependencies, runs anywhere
pnpm test:e2e     # integration — needs the docker-compose stack + migrations applied
```

`test/rls.e2e-spec.ts` is the milestone's centerpiece: it proves, with a
raw query bypassing `ServerAccessService` entirely, that a non-owner's
RLS-scoped read of another user's server returns zero rows — the database
is the backstop, not just application code (architecture doc 2.4). It also
proves the reverse: a write to an RLS-enabled table with **no** RLS
context set is rejected outright by the `WITH CHECK` policy, and that
`audit_logs` refuses `UPDATE`/`DELETE` at the database level regardless of
who's asking.

`test/auth.e2e-spec.ts` covers login/refresh/logout plus the two
security-critical scenarios: uniform error shape for a nonexistent vs.
wrong-password login, and refresh-token reuse revoking the whole session
family. `test/nodes.e2e-spec.ts` plays the agent's role by hand over HTTP
to prove the full bootstrap→heartbeat handshake, admin-only access, node
token rejection/rotation, and allocation range import/dedup/limits.
`test/templates.e2e-spec.ts` covers egg/nest CRUD and the agent-compatible
variable-name validation. `test/plans.e2e-spec.ts` covers plan CRUD and
defaults. `test/servers.e2e-spec.ts` is M5's centerpiece: proves the
create transaction reserves capacity/allocation correctly, that
**5 concurrent creates against a node sized for exactly 2 never
overcommit it** (the milestone's explicit DoD requirement — 2 accepted,
3 rejected `NO_CAPACITY`, verified against the DB afterward), the
agent's install-completed callback (node-scoped, wrong-node rejected),
and the plan/node/template in-use delete guards. `test/client-servers.e2e-spec.ts`
(M6) covers the owner-facing surface: list/get scoped to the caller only,
a well-formed EdDSA console token minted only for the owner, and a power
action reaching real `AgentClient` wiring. `test/files.e2e-spec.ts` (M7)
covers the same ownership scoping for every file route, plus that a
minted download/upload link carries a correctly-scoped `ctx.path` and,
for uploads, a caller-requested `maxBytes` capped at the outer ceiling.

**Verified, all green, against a real Postgres 17 + Redis 7
(`docker-compose.dev.yml`):** `tsc --noEmit` clean · 43 unit tests ·
50/50 e2e tests across 8 suites (RLS, auth, nodes, templates, plans,
servers, client-servers, files) · `nest build` + the compiled server booted for real, seeded
root admin logged in over HTTP and received a valid access token ·
`/healthz` and `/readyz` both report healthy against live dependencies ·
**the real compiled Go agent binary bootstrapped and heartbeated against
this real running server**, no mocks on either side (see
`../../agent/README.md`).

Note for e2e runs on Windows: `@fastify/cookie`'s `cookie` dependency uses
a dynamic `import()`, which Jest's CommonJS runtime can't execute without
`NODE_OPTIONS=--experimental-vm-modules` — already wired into
`pnpm test:e2e`. This only affects the Jest sandbox; the real server
(`pnpm start` / `nest build && node dist/src/main.js`) is unaffected,
since plain Node supports `import()` from CommonJS natively.
