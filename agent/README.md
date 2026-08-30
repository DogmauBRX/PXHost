# PXHost Node Agent

Go daemon that runs on each hosting node and drives Docker on behalf of the
PXHost panel. See [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) section 4
for the full design.

## Status: M14 — Billing hooks (final roadmap milestone; no agent-side bugs found)

Milestone DoD (architecture doc roadmap): **external payment event
idempotently suspends/restores a server.** Marked "(deferred)" in the
roadmap and scoped to "API" only there — but that DoD sentence presumes
a WHOLE suspend/restore mechanism that turned out not to exist anywhere
yet: no code read or wrote `servers.suspended_at`/`suspension_reason`,
`ServerAccessService.can()` had no status gate at all, and this repo's
own `StatusServerSuspended` WS close code (4009) had been declared since
M2 and never once referenced. This milestone builds that mechanism for
real — the billing webhook itself (`../apps/api/README.md`) is a thin
last step on top of it.

- **`internal/spec/types.go`** — `Server.IsSuspended bool`, the second of
  architecture doc 2.5's two independent enforcement points (the panel
  API's status gate is the other).
- **`internal/srv/suspend.go`** (new) — `Server.SetSuspended(ctx, dc,
  suspended)`: setting `true` also force-KILLS a running container
  immediately, not a graceful stop — a customer whose payment just
  failed doesn't get a 30-second grace period a normal shutdown would.
  Unsuspending only clears the flag; it does NOT auto-start the server
  (matching this package's existing precedent — a transferred server
  isn't auto-started either — "usable again" isn't the same promise as
  "already running"). `Server.Start` gained one more guard,
  `ErrServerSuspended`/409, checked before any Docker call.
- **`internal/api/routes_server.go`** — `PATCH /api/servers/{uuid}/suspend`
  (node-token-gated, body `{suspended: bool}`).
- **`internal/api/ws.go`** — a new-connection check right after
  successful auth: `sess.server.Suspended()` closes with
  `StatusServerSuspended` (4009) if true. This is genuinely the SECOND
  layer, not a redundant one: `authenticate()` already independently
  refuses when the presented token lacks `websocket.connect` (which a
  freshly-minted token for a suspended server now correctly never has —
  see the panel-side bug this milestone found, `../apps/api/README.md`
  #25) — but a token minted moments BEFORE a suspension is still fully
  valid and still carries that permission. Proven live: connecting with
  a PRE-suspension token against a since-suspended server correctly hit
  this check specifically (4009, not the earlier 4000), confirmed via
  the agent's own log line ("ws authenticated" immediately followed by
  "ws rejected: server is suspended") — the exact race this second layer
  exists to close.

No agent-side bug found this milestone — `Start`'s suspended-guard and
`Suspended()`'s flag read (`internal/srv/suspend_test.go`, new) passed
on the first attempt, and every piece of the live run below (real force-
kill, real WS rejection at both the token-permission layer and this
package's own explicit check) matched what the tests already predicted.

**Run for real, full stack:** a real server was created, started (a real
running `alpine:3.19` container), then suspended via the real admin API
— the container immediately went to `Exited (137)` (a real SIGKILL, not
a mock), confirmed via `docker inspect`. A power `start` attempt as the
real owner correctly 403'd. Two capability-token scenarios were both
proven against the real running agent: a token minted AFTER suspension
carried zero `control`-group permissions and failed auth outright
(`hack/wsclient`, a real WS close frame, code 4000); a token minted
BEFORE suspension (while the server was briefly unsuspended for this
exact test) still carried full permissions, connected successfully past
`authenticate()`, and was THEN rejected by this milestone's own new
check (code 4009) — the log line ordering itself is the proof this is a
second, independent layer and not just the same check twice. A real
signed billing webhook (`../apps/api/README.md`) was then fired twice
against this same live server — `invoice.payment_succeeded` correctly
restored it (real `docker ps` confirmed a fresh container running again
after a normal `start`), `invoice.payment_failed` correctly force-killed
it again. All M14 test infrastructure was torn down afterward.

## Status: M13 — Hardening & operations (live node-to-node transfer, token rotation, JWKS; no agent-side bugs found)

Milestone DoD (architecture doc roadmap): **live node-to-node transfer
with no data loss; token rotation; log partition automation.** The third
item is entirely API/DB-side (see `../apps/api/README.md`); this repo
carries the other two.

### Node-to-node transfer

- **`internal/srv/transfer.go`** — `Server.Export(ctx, provider)`: the
  source half. Deliberately requires the server already stopped (unlike
  `Backup`, which explicitly allows a running server) — a transfer is a
  one-way, irreversible move (the source container and data directory
  are deleted once the target confirms success), so an in-flight write
  during export would be real, unrecoverable data loss in a way a backup
  alongside a still-live original never risks. Reuses `ErrServerNotStopped`
  /409, same contract as `Restore`.
- **`internal/backup`** gained `Provider.Put(ctx, serverUUID, id,
  io.Reader) (Backup, error)` — `Create`'s mirror image: lands bytes
  fetched from another node directly (no server-local `fsx.Jail` to walk;
  the bytes already ARE the tar.gz). This is the ONLY new archive
  primitive the whole feature needed — export reuses `Create`, the
  target's extraction reuses `Restore`, both already existed for backups.
- **`internal/api/routes_transfer.go`** (new) — four endpoints:
  `POST .../transfer/export` (node-token-gated, source), `GET
  .../transfer/archive/{id}/download` (a signed `transfer.download`
  capability token, hit by the TARGET agent's own HTTP client — same
  posture as a backup download, just agent-to-agent instead of
  browser-to-agent), `DELETE .../transfer/archive/{id}` (cleanup), and
  `POST /api/servers/transfer/import` (node-token-gated, target):
  registers the server under its ORIGINAL uuid (a transfer moves a
  server, it doesn't create a new one), fetches the source's archive,
  extracts it straight into the freshly-registered (and therefore
  already-empty) jail — no staging-dir-then-atomic-swap needed the way
  restoring into an EXISTING server requires — then builds the container.
  No install script runs: the transferred data already IS the server's
  content. Same "202 now, real answer later" shape as create+install,
  reported via a new `panel.Client.TransferResult` callback.
  `buildServerSpec` was factored out of `routes_create_server.go` so
  import and create share the exact same env/limits/allocations
  translation.
- A server's `uid` is NOT persisted anywhere (confirmed while building
  this: `servers` has no `uid` column — the panel computes a fresh
  `UID_BASE + count` per node at creation and never stores it). This
  turned out to simplify transfer considerably: the target gets its OWN
  freshly-computed uid, independent of the source's, because tar archives
  never carry ownership bytes in this codebase (`fchownat` always applies
  the CALLER's uid at write time, not something baked into the archive) —
  no uid remapping step was needed at all.

### Token rotation

- **`internal/api/tokenstore.go`** (new) — `TokenStore`, an
  `atomic.Value`-backed hot-swappable string. Replaces the plain
  `nodeToken` field `Server`/`wsSession` used to hold: rotation must
  update the ONE value every incoming-request check and every outgoing
  call reads through, with no window where a request racing a rotation
  sees a stale value.
- **`internal/panel/client.go`** — `RotateToken(ctx, currentToken)
  (*RotateTokenResponse, error)`, `FetchJWKS(ctx)
  (map[string]ed25519.PublicKey, error)`.
- **`cmd/pxagent serve`** gained two new background loops alongside the
  existing heartbeat loop: `runTokenRotationLoop` (self-rotation on
  `node.json`'s `token_rotation_interval_hours`, 0 = disabled) and
  `runJWKSRefreshLoop` (every 5 minutes, per architecture doc 3.4 — fetches
  immediately on startup too, so a key rotated moments before an agent
  boots is trusted without waiting a full interval). `pxagent
  rotate-token` is the same self-rotation call as a one-shot CLI command,
  for manual/offline use.
- **`internal/auth.TokenVerifier`** — was a single `publicKey`; now holds
  `keys map[string]ed25519.PublicKey` (by `kid`, swapped atomically by
  `SetKeys` on every JWKS refresh — never merged incrementally, so a key
  the JWKS stops listing stops verifying on the very next refresh) plus a
  `fallback` key (the static `panel_public_key_path` file — used only
  before the first successful JWKS fetch, or in standalone mode).

No agent-side bug found this milestone — every new code path passed its
own unit tests on the first attempt (`internal/srv/transfer_test.go`,
`internal/auth/jwt_test.go`'s new multi-key rotation tests) and the
subsequent live run below didn't turn up anything the tests hadn't
already caught. The two real bugs THIS milestone's live run did surface
were both API-side — see `../apps/api/README.md` bugs #20-24 — including
one (`AgentClient`'s HTTP timeout exactly matching this agent's own
30-second stop grace period) that looked at first like an agent-side
stop bug: a real `power stop` against `sleep 3600` legitimately took the
full ~30s to escalate through Docker's own SIGTERM-then-SIGKILL sequence
post-restart, and the panel's HTTP client gave up at the exact same
30-second mark, misreporting a stop that was actually still succeeding
server-side as a failure.

**Run for real, full stack, two independent node processes on one
machine:** two real `pxagent` processes were bootstrapped against two
real (fake, for the purpose of this single-machine test) nodes,
listening on distinct loopback addresses (`127.0.0.1:8643` /
`127.0.0.2:8644`, mirroring the e2e suite's own distinct-loopback
pattern) since a real deployment's two nodes would each have their own
address but this dev machine has one Docker Engine shared by both. A
real server was provisioned on the source node, started, and a marker
file written directly into its data directory. The full transfer
pipeline ran for real: source stopped, a real `tar.gz` archived to
`transfer_dir`, a real Ed25519 `transfer.download` capability token
minted and used by the TARGET agent's own HTTP client to fetch it
(verified via a live `panel.FetchJWKS` call against the real running
panel, separately confirming the JWKS side below), extracted into a
fresh jail, a real container created on the target. Afterward the
marker file's sha256 on the target matched the source's byte-for-byte,
the `servers` row's `node_id` had moved, the source's allocation was
freed and the target's promoted to primary, and the server started
normally on its new node. (One test-topology caveat, not a product bug:
since both "nodes" share this one machine's single Docker Engine,
container NAMES collide across them — `pxhost-<uuid>` on the source
blocks the identical name on the target until the source's copy is
actually removed. A real deployment's two nodes have two separate Docker
Engines, so this never arises there; proving it here required manually
clearing the source's stopped container between export and import,
documented rather than worked around in code.)

Token rotation was verified on both paths: agent self-rotation (`pxagent
rotate-token`) — the OLD token was rejected by the panel on the very
next heartbeat (confirming it was truly dead, not just locally
forgotten), the agent process was restarted to pick up the new one from
`node.json`, and heartbeats resumed normally. Admin-forced rotation (the
panel's "Rotar token" button / `POST /api/admin/nodes/:id/rotate-token`)
— the target node's heartbeat immediately started failing with a real
401, a fresh bootstrap token was issued in the same response, and the
node was successfully re-bootstrapped and brought back online with it.

JWKS rotation was verified end to end: after `POST
/api/admin/security/signing-keys/rotate`, a freshly-minted console
capability token's header carried the NEW `kid`; `GET /api/remote/jwks`
correctly listed both the new (current) and old (now-retiring) public
keys; a real `panel.Client.FetchJWKS` call from this repo's own code,
run against the live panel, correctly fetched and decoded both 32-byte
keys; `POST .../signing-keys/{kid}/retire` then removed the old key from
the JWKS entirely. All M13 test infrastructure (both node processes, the
transferred server's container, every DB row) was torn down afterward.

## Status: M12 — Admin console (live resource resize; no agent-side bugs found)

M12 is scoped to Panel + API per the roadmap table, but a real admin
"apply this plan to its servers" button is hollow without an actual live
effect on the container — a DB-only "apply" would just be a UI toy. This
repo's contribution is the one piece only the agent can provide: resizing
a **running** container's cgroup limits without recreating or restarting
it (architecture doc 4.5's resource-management surface, previously
create-time-only).

- **`internal/spec/hostconfig.go`** — the cgroup-limit-building logic
  `BuildContainerSpec` already had (memory/reservation/swap/swappiness,
  OOM-kill-disable, CPU period+quota, blkio weight, pids limit, ulimits)
  is now its own exported `BuildResources(limits Limits, node Node)
  container.Resources`, called both at create time and from the new
  live-update path below — one function computing cgroup limits, not two
  copies that could drift apart. `resources_test.go` adds a
  `reflect.DeepEqual` regression test tying `BuildContainerSpec`'s own
  resource block to a direct `BuildResources` call, so the two can never
  silently diverge again.
- **`internal/dockerx/client.go`** — `UpdateContainer(ctx, id, resources
  container.Resources)` wraps Docker's `ContainerUpdate` API, the one
  Docker Engine call that changes cgroup limits on an already-running
  container in place.
- **`internal/srv/server.go`** — `Server.UpdateLimits(ctx, dc, newLimits
  spec.Limits)`: updates `s.spec.Limits` under the existing server mutex
  regardless of container state (so a stopped server's next `Start` picks
  up the new limits too), and additionally calls `dc.UpdateContainer`
  when a container currently exists — best-effort against a live
  container, not a precondition for the state update to matter.
- **`internal/api`** — `PATCH /api/servers/{uuid}/limits`
  (`routes_server.go`'s `handleUpdateLimits`, registered in `server.go`),
  node-token-gated like every other server-scoped route, called by the
  panel API's plan-apply flow (see `../apps/api/README.md`).

No agent-side bug found this milestone — `BuildResources`'s extraction
was mechanical (verified byte-identical to the old inline block via the
`reflect.DeepEqual` test before it ever touched a real container), and
`UpdateContainer`/`UpdateLimits` worked against the real local Docker
Engine on the first live attempt.

**Run for real, full stack, UI-only onboarding through to a live resize:**
a brand-new location, node, and bootstrap token were created entirely
through the admin panel's UI; the real compiled `pxagent.exe` (rebuilt
from this milestone's source) redeemed that real token
(`pxagent bootstrap`), ran `network ensure` against the real Docker
network, then `pxagent serve` for real — the node reached `healthStatus:
"online"` with a real Docker Engine version reported, exactly like every
earlier milestone's live node. A new template group + template (with one
variable) and a new plan were created through the UI on top of that node;
a real server was provisioned onto it and started, producing a real
running `alpine:3.19` container (`docker inspect` confirmed
`Memory=268435456` / 256 MB, matching the plan). The plan was then edited
in the UI (256→512 MB, 100%→50% CPU), the dry-run drift report correctly
showed the one affected server with the exact before→after values, and
clicking Apply drove this milestone's new code path end to end: `docker
inspect` afterward showed `Memory=536870912` (512 MB) and
`CpuQuota=50000`/`CpuPeriod=100000` (50%) on the **same container**,
`State.Status` still `running` throughout — a real live resize with zero
downtime, not a restart-and-hope. A second dry run immediately after
confirmed the drift had dropped to zero. All test infrastructure (the
node's process, its Docker container, and every DB row created for this
run) was torn down afterward.

## Status: M11 — Subusers, granular RBAC, activity feed (one real gap found live; small, targeted agent-side addition)

M11 is scoped to API + Panel per the roadmap — but the DoD ("every
mutation attributed in the feed") turned out to have exactly one blind
spot only this repo could close: the console's power buttons
(Reiniciar/Parar/Iniciar/Forçar parada) send `power:set` over the
browser<->agent WebSocket DIRECTLY (architecture doc 4.5/5.2 — the panel
API mints the capability token and gets out of the way), so a WS-driven
restart is invisible to the panel's own request-scoped activity logging
no matter how thoroughly that side gets retrofitted. This agent is the
only party that ever learns both "the action happened" and "which real
user's capability token authorized it" (`claims.UID`, already carried by
every WS session since M6).

- **`internal/panel/client.go`** gained `ReportActivity` — a fourth
  outbound call alongside `Bootstrap`/`Heartbeat`/`InstallCompleted`,
  same shape: POST to `/api/remote/servers/{uuid}/activity` with the
  node's bearer token.
- **`internal/api/ws.go`**'s `handlePowerSet` calls it, best-effort,
  after a power action actually succeeds — on `sess.bgCtx`, not the
  frame-handling context, for the same reason `Start`'s console attach
  already does: this call must outlive the WS frame (and possibly the
  whole connection) that triggered it. A panel outage never blocks or
  reverts a power action that already happened against the real
  container — this is purely "tell the feed," not "ask permission."

17. **Found live, not a defect in shipped code — a genuine gap the DoD's
    own wording exposed**: every REST-driven mutation (files, backups,
    databases, schedules, and even the REST `/power` endpoint nothing in
    the panel actually calls) was already correctly attributed once M11's
    API-side retrofit landed — but the panel's ACTUAL console buttons
    go over WebSocket, a path that had simply never been asked to report
    anywhere. Confirmed by literally clicking the real Reiniciar button
    as a real second, permission-scoped user account and watching the
    owner's activity feed show nothing for it. Fixed by the addition
    above; re-verified live afterward — the exact same click now
    produces `server.power.restart` attributed to the clicking user,
    confirmed via `docker inspect`'s real container restart timestamp
    lining up with the activity log entry's timestamp, not just a
    plausible-looking row.

No new unit test for `ReportActivity`/`handlePowerSet`'s call to it —
`internal/srv`'s `dockerFull` being a concrete `*dockerx.Client` alias
rather than an interface (noted in M10's bug #16) means there's no seam
to unit-test a real power action through in the first place; this was
proven live instead, the same way `Start`/`Stop`/`Kill` already are. The
panel-side endpoint this calls IS regression-tested — see
`../apps/api/README.md` bug #19.

## Status: M10 — Schedules (no planned agent-side work; one real bug found and fixed anyway)

M10 (Schedules) is scoped to API + Panel only (architecture doc roadmap
— the worker dispatches tasks by calling the SAME `power`/`backups`
agent endpoints every other milestone already uses, nothing new on this
side). Live-testing it anyway — a real unattended nightly
restart+backup, run for real — surfaced a genuine, pre-existing agent
bug unrelated to scheduling itself.

16. **A `power:restart` whose stop phase didn't finish before the
    caller's own timeout left the server PERMANENTLY stuck reporting
    `"stopping"`, even after Docker had actually killed the container.**
    `Server.Stop` (`internal/srv/server.go`) sets `State = StateStopping`
    optimistically before calling `dc.StopContainer`, but — unlike
    `Server.Start` right above it, which already resolves its own
    equivalent failure to `StateCrashed` — never rolled that back on
    error. A caller's context being cancelled (an HTTP request's
    client-side abort, or in this case a background worker's own 30s
    `AgentClient` timeout) while `StopContainer` was still in flight
    server-side left `State` stuck at `"stopping"` forever: every
    subsequent `Stop()` hit `Stop`'s own `"already stopping"` guard and
    failed immediately, with no recovery path except `Start` (whose
    guard doesn't check for `StateStopping`). Found live: a schedule's
    `power` task failed with `Agent request failed: This operation was
    aborted` against a real (slow-to-SIGTERM-handle) alpine test image,
    and every following restart attempt failed with `"already
    stopping"` until a `start` action forced a transition. Fixed by
    mirroring `Start`'s own pattern exactly — on a `StopContainer`
    error, `State` resolves to `StateCrashed` (not blocked by either
    guard) instead of staying at the transitional `StateStopping`.
    Verified live, before and after: rebuilt the agent, reproduced the
    exact same slow-stop timeout against a fresh server, and confirmed
    the very next restart attempt now reports `"previous":"crashed"` and
    succeeds immediately, instead of `"already stopping"` forever. Not
    covered by a new unit test — `internal/srv`'s `dockerFull` is a
    concrete `*dockerx.Client` type alias, not an interface, so this
    package's lifecycle methods (`Start`/`Stop`/`Kill`/`Remove`) have no
    existing unit coverage at all to extend; a real-Docker-daemon
    regression test for this specific case is a reasonable follow-up but
    was judged out of scope for a milestone with no planned agent work.

See `../apps/api/README.md` and `../apps/panel/README.md` for the actual
M10 feature work (BullMQ worker, cron scheduling, the Schedules UI).

## Status: M8 — Backups (agent side)

Builds on M7 (below). New here:

- **`internal/backup`** (`provider.go`, `local.go`, `ignore.go`,
  `restore.go`) — `LocalProvider` streams a server's jail-resolved file
  tree straight into `tar.gz` via `io.MultiWriter` (constant memory, a
  sha256 tee'd during the same write, no full-archive buffering), storing
  both the archive and a JSON sidecar (`{sizeBytes, sha256, createdAt}`)
  under `node.BackupDir` — deliberately OUTSIDE any server's own
  filesystem jail (architecture doc 4.5), so a compromised container can
  never delete or inflate its own backups. `IgnoreSet` matches glob,
  basename, and directory-prefix patterns. Restore is two-pass: `tar`
  carries no upfront central directory the way zip does, so
  `validateRestoreArchive` walks the whole stream once (entry count ≤
  200,000, total bytes ≤ 50 GiB, every path checked for tar-slip) before
  `extractRestoreArchive` writes a single byte — the same "prove it's
  safe before touching disk" posture M7's `archive.go` uses for zip.
- **`internal/srv/backup.go`** — `Server.Backup` (no stop required — a
  running server's files are still a coherent-enough snapshot, and
  forcing a stop for every scheduled backup would be unacceptably
  disruptive) and `Server.Restore` (REQUIRES `StateOffline`, returns the
  sentinel `ErrServerNotStopped` otherwise): extract into a sibling
  `<uuid>.restore-staging` dir, close the live `Jail` (an `O_PATH` fd
  tracks an inode, not a path — it does NOT follow a rename), `os.Rename`
  the live data dir aside to `<uuid>.restore-old`, rename staging into
  its place, reopen a fresh `fsx.Jail` against the now-restored path, and
  background-delete `.restore-old` after a fixed one-hour grace window —
  "the old directory is kept ... so a bad restore is recoverable"
  (architecture doc 4.5), proven live below, not just by the unit tests.
- **`internal/api/routes_backups.go`** — list/create/delete/restore
  (node-token-gated, same pattern as files' small ops) and a signed-URL
  `GET .../backups/{id}/download` (capability `backup.download`,
  single-use like a file download token). `writeBackupError` maps
  `srv.ErrServerNotStopped` to a `409` specifically, distinct from every
  other failure's `502` — the one deliberate non-uniform status code in
  this router, because "restore while running" is a conflict the CALLER
  can act on (stop the server, retry), not an agent/infra failure.

No new agent-side bugs this milestone — `internal/backup` and
`internal/srv/backup.go` shipped with 18 passing tests (11 + 3 + 4 across
`local_test.go`/`restore_test.go`/`backup_test.go`/`routes_backups_test.go`)
on both Windows and real Linux (WSL2) before the live run below, including
`TestRestore_TarSlipEntryNeverEscapesTheStagingJail` and a grace-window
survival test. The live run's two hiccups were both test-harness
misconfiguration, not agent defects, and are recorded here because they
cost real debugging time:

- A template's `startupCommand` of `sh -c 'sleep 3600'` was rejected with
  `spec: startup command may not begin with a shell/interpreter ("sh")` —
  this is `internal/spec/argv.go`'s `forbiddenArgv0` check doing exactly
  what architecture doc 3.6 asks (a customer-facing startup command can
  never shell out), working as designed against a real Docker daemon for
  the first time this milestone. Not a bug; fixed the test fixture
  (`sleep 3600` directly) instead of the agent.
- `node.json`'s `install_dir` was left empty for a live Windows run,
  producing a RELATIVE bind-mount source (`<uuid>\install.sh`) that
  Docker's API rejected outright: `"...install.sh" is not a valid Windows
  path`. `internal/srv/install.go` has always required `node.InstallDir`
  to be set (`filepath.Join(s.node.InstallDir, s.UUID)`); this was a gap
  in the live-test node.json, not in the agent, which never silently
  falls back to a relative path.

**Run for real, full stack:** a real `alpine` server was created, started,
and had a file edited through the panel (`install.marker` → a distinct
marker string), backed up through the real panel UI, the marker
overwritten to a different string, a restore attempted WHILE the server
was still running (rejected live with a real `409`, not a mock), the
server stopped, the same restore retried and SUCCEEDED — the marker file
was confirmed back to its pre-backup content by reading it directly off
disk, not just trusting the UI. The backup archive and its `.restore-old`
grace-window directory were both confirmed to exist on disk outside the
server's own data directory. A real signed backup-download link was
minted, fetched once by a real browser (200, single-use token burned),
and a manual replay of the same token was confirmed rejected
(`already used (single-use)`). See `../apps/api/README.md` (bug #14 — a
real bug found during this same run, API-side) and
`../apps/panel/README.md` for the rest of this run.

## Status: M7 — File manager (agent side)

Builds on M6 (below — M6 itself added nothing agent-side). New here:

- **`internal/fsx`** (`jail.go`, `jail_linux.go`, `jail_other.go`, `ops.go`,
  `quota.go`, `archive.go`) — the filesystem jail, architecture doc 4.4's
  "load-bearing" security section. On Linux, every operation resolves
  through `openat2(RESOLVE_BENEATH|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV)`
  against an `O_PATH` dirfd opened once per server at registration — the
  kernel itself is the enforcement point, not a lexical string check. A
  1000-iteration concurrent symlink-swap test (`jail_linux_test.go`,
  Linux-only) proves it: one goroutine continuously replaces a path
  component with a symlink pointing outside the jail while eight readers
  hammer the same relative path — the SAME test that, before an actual
  bug fix, genuinely returned attacker-controlled outside content. A
  non-Linux build (`jail_other.go`) exists ONLY so the agent compiles and
  the HTTP plumbing can be exercised on this project's own Windows dev
  machine — explicitly not the security boundary, matching the
  architecture doc's own words that the string-based fallback is "dead
  code, not shipped as a real path." Archives are zip, with independent
  entry-count/total-size/compression-ratio bomb caps checked against the
  central directory before a single byte is extracted, symlink/device
  entries skipped and reported, setuid/setgid/sticky stripped from every
  extracted mode.
- **`internal/auth`** — `Capability` gained `file.download`/
  `file.upload`; `Claims` gained `Ctx *TokenContext{Path, MaxBytes}`;
  `TokenVerifier.VerifyFileToken` additionally checks the token's `ctx.
  path` matches the path actually requested and burns the `jti` via a new
  `ReplayCache` (`replay.go`) — a file transfer token is single-use, a
  console token is not (architecture doc 3.4).
- **`internal/srv.New`** now creates `<node.DataDir>/<uuid>` itself
  (`os.MkdirAll` + `fsx.Open`) instead of leaving it to Docker's
  auto-create-missing-bind-mount-source side effect — closes a gap
  flagged back in the M5 README ("in the full agent this is fsx's job
  \[for] a later milestone"). `New` now returns `(*Server, error)`.
- **`internal/api`** — file "small ops" (list/contents/rename/delete/
  mkdir/chmod/compress/decompress), node-token-gated like power actions;
  signed-URL `GET .../files/download` and `POST .../files/upload`, hit
  directly by the browser with a single-use capability token, wrapped in
  a new `corsForBrowser` middleware (reusing the same origin allowlist
  the console WS already trusts) since a `fetch()` upload needs to read
  the JSON response back, unlike a plain download navigation.

### Four real bugs found (three in `fsx` before it ever left this milestone, one more from live browser/cross-platform testing)

12. **`sanitize()` silently rewrote `"../etc/passwd"` into `"etc/passwd"`
    instead of rejecting it.** `path.Clean("/"+x)` — the ".." pre-check
    ran AFTER Clean, by which point Clean's own documented behavior (a
    leading ".." on a rooted path is absorbed, not flagged) had already
    erased the evidence. Not exploitable (the result still resolved
    safely inside the jail), but it silently reinterpreted a request
    instead of doing what architecture doc 4.4 explicitly says: reject.
    Fixed by checking for a literal `".."` component on the RAW input
    before any cleaning.
13. **`List()` always returned zero entries, real Linux only.**
    `os.File.ReadDir()`'s per-entry `DirEntry.Info()` stats each name by
    constructing `"<fd's reported name>/<entry>"` and calling a plain
    `Lstat` — resolved against the PROCESS's cwd, not the directory the
    fd actually points at. A jail-resolved fd is named after its
    jail-relative path (e.g. `"."`), so every `Info()` call failed with
    ENOENT and was silently skipped by a `continue` meant for a much more
    benign race. Passed on Windows (the dev-fallback path never goes near
    this API) — only real Linux, real `openat2` exposed it. Fixed by
    reading names only (`Readdirnames`) and stat'ing each one through the
    SAME jail-resolved primitive every other operation uses.
14. **The console rate limiter could spuriously reject the very first
    burst token — real Linux only, a pre-existing bug this milestone's
    cross-platform testing happened to catch.** `NewRateLimiter` seeded
    `last` from a real `time.Now()` call; a test that later froze the
    clock via the injectable `now` func could end up with `last` fractions
    of a second AHEAD of the frozen `now`, making `elapsed` briefly
    negative and silently draining tokens. Passed reliably on Windows
    (coarser back-to-back clock reads), failed deterministically on WSL2.
    The REAL-world equivalent is an NTP correction moving the wall clock
    backward mid-session. Fixed by clamping negative elapsed to zero.
15. **A real cross-origin upload from the browser needs an explicit CORS
    preflight handler** — the panel-side half of this bug is documented
    in `../apps/api/README.md`; the agent's own half (this repo) is the
    new `corsForBrowser` middleware and its `OPTIONS` route registration,
    without which `fetch()`'s response to a `POST .../files/upload` is
    unreadable by the panel's JS even though the bytes land on disk fine.

**Run for real, full stack:** a real server's `server.properties` (written
by its own real install script) was listed, opened, edited, and saved from
the real panel UI in a real browser — the edited bytes were confirmed on
disk. A real signed download link and a real signed upload link were both
exercised directly against the real running agent (`curl`, not a mock),
each token verified offline and burned on first use. See
`../apps/api/README.md` and `../apps/panel/README.md` for the panel-side
half of this same run, including the CORS bug found there.

## Status: M5 — Dynamic server provisioning

Builds on M4 (below). New in M5:

- **`internal/spec/install.go`** — `BuildInstallContainerSpec`: the
  throwaway container that runs a template's install script (architecture
  doc 3.6). Shares most of the real server container's security posture
  (dropped caps, no privileged mode, seccomp/AppArmor, no Docker socket)
  but differs deliberately: writable rootfs (installers need /tmp and
  package caches), limits independent of and tighter than the server's own
  plan (min(server memory, 1 GiB), 100% CPU, 256 pids — admin-authored
  script, not customer-controlled, but still shouldn't starve a tiny
  plan's installer), and a constant two-element argv
  (`[entrypoint, "/mnt/install/install.sh"]`) — the one place argv[0] is
  allowed to be a shell interpreter, because the script is admin-authored
  template content, never customer input. The persistent volume is
  mounted at `/mnt/server` during install (not `/home/container`, which
  the running server sees later) — a real template's install script must
  write there.
- **`internal/srv/install.go`** — `Server.Install`: writes the script to
  `<node.InstallDir>/<uuid>/install.sh` (mode 0500, chowned to the
  server's uid, outside the customer's own data directory so the running
  server can never read or modify its own installer), pulls the install
  image, runs the container attached to the same console `Hub` the real
  server later uses (so a customer watching mid-install sees live
  progress), waits with a timeout, and force-removes the container
  afterward regardless of outcome.
- **`POST /api/servers`** / **`DELETE /api/servers/{uuid}`** — the panel's
  entry points for dynamic provisioning: build the spec from the request,
  pull, create, respond `202` immediately, then run the install
  asynchronously on the agent's process-lifetime context and report the
  result back to the panel via `internal/panel.Client.InstallCompleted`.
- **`dockerx.Client.WaitContainer`** — blocks for a container's exit code
  via the Engine API's wait endpoint, used by `Install` instead of
  polling.

**Run for real, full stack, against a real Docker daemon:** the real
compiled `pxagent` binary was bootstrapped against a real running panel
(same handshake as M4), then received a real `POST /api/servers` from
that panel. It pulled `alpine:3.19`, created the game server container,
ran a real install container that wrote a file to the real
bind-mounted persistent volume, and called back
`/api/remote/servers/:uuid/install-completed` — the panel showed
`status: "ready"`. See `../apps/api/README.md`'s M5 section for the panel
side and its own bug found in this same run (a Postgres `inet` cast
leaking a `/32` suffix into the IP handed to Docker).

### Two real bugs found during the live cross-language run

10. See `../apps/api/README.md` bug #10 — the panel was sending
    `"203.0.113.50/32"` as an allocation's IP (a Postgres `inet::text`
    artifact), which this agent's Docker client correctly rejected via
    the real daemon's own address parser. Fixed panel-side; the agent's
    behavior here was correct, just downstream of bad input — worth
    noting because it's the kind of contract mismatch that only a real
    two-process, real-Docker run surfaces. Neither side's own test suite
    (Go unit tests with no Docker, NestJS e2e tests with no live agent)
    could have caught it.
11. **The install container failed to even start**, independent of bug
    10 and found right after fixing it: `failed to initialize logging
    driver: compression cannot be enabled when max file count is 1`.
    `BuildInstallContainerSpec`'s `LogConfig` set `max-file: "1"` for the
    `local` driver without disabling `compress` — and Docker's `local`
    driver defaults `compress=true`, which is invalid with a single kept
    file (nothing to rotate into). Every install, on every real node,
    would have failed at container start, unconditionally — a case
    entirely orthogonal to game-server behavior, so nothing in
    `internal/spec`'s existing unit tests (which assert on Go struct
    fields, not on what the Docker daemon actually accepts) exercised it.
    Fixed by adding `"compress": "false"` explicitly; regression-tested
    in `install_test.go`
    (`TestBuildInstallContainerSpec_LogCompressionDisabledForSingleFile`),
    but that test only proves the Go struct is now correct — it took the
    real daemon rejecting the old config to find the bug in the first
    place.

## Status: M4 — Infrastructure catalog (panel bootstrap + heartbeat)

Builds on M2 (below). New in M4:

- `internal/panel` — the outbound client to the NestJS panel's
  `/api/remote/*` surface: `Bootstrap` (trade a single-use, admin-issued
  token for a long-lived node token) and `Heartbeat` (periodic liveness
  report). Deliberately never fatal on failure — a panel outage must not
  take down a node's already-running game servers.
- `cmd/pxagent bootstrap --panel <url> --token <bootstrap-token> --node
  node.json` — redeems the token, then writes `node_uuid`/`node_token`/
  `panel_url`/`heartbeat_interval_seconds` back into node.json, merging
  with whatever node-local config (network, security profiles, uid range)
  is already there.
- `cmd/pxagent serve` now heartbeats to the panel on a fixed interval for
  as long as it runs, whenever `node.json` has `panel_url` set (i.e. after
  a successful `bootstrap`) — the first heartbeat fires immediately so the
  node doesn't wait a full interval to show `online`.
- `dockerx.Client.Version` — reports the connected Docker daemon's real
  version string on bootstrap and every heartbeat.

**Run for real, not just tested in isolation:** a node was created via the
panel's admin API, a bootstrap token issued, and the actual compiled
`pxagent` binary (`pxagent bootstrap`) redeemed it against the actual
running NestJS server backed by actual Postgres — no mocks on either side.
`pxagent serve` then heartbeated on its own schedule; the panel's admin API
showed `healthStatus: "online"`, the live local Docker Engine version, and
an advancing `lastHeartbeatAt` throughout. See
`../apps/api/README.md`'s M4 section for the panel side of this same run.

## Status: M2 — Agent API (auth, console, stats)

What exists today:

- `internal/spec` — the pure `BuildContainerSpec` function and its
  supporting pieces (`BuildArgv` tokenize-then-substitute, `BuildEnv`
  allowlist/denylist, mount validation). This is the security-critical
  package: every container isolation invariant (no privileged mode, all
  capabilities dropped, read-only rootfs, non-root uid, no Docker socket,
  bounded resources) is asserted by fast unit tests with no Docker
  dependency — run them with `go test ./internal/spec/...`.
- `internal/dockerx` — a thin wrapper over the official Docker Engine API
  client (digest-verified pulls, network setup, container CRUD + power
  actions, container attach, long-lived stats streaming).
- `internal/srv` — per-server lifecycle (`Server`, `Manager`), serializing
  all Docker calls for a given server through one mutex. Owns two
  background workers per running server: a `console.Pump` (attached
  *before* start, so no boot output is lost) and a `stats.Collector`, both
  tied to a server-lifetime background context — never a request-scoped
  one (see "bugs found" below).
- `internal/console` — the live console: a `Ring` buffer (replay on
  reconnect, gap detection), a `Hub` (fan-out with non-blocking,
  drop-on-backpressure delivery so one slow subscriber can never stall
  another), the attach/demux `Pump`, and console-input rate limiting +
  sanitization.
- `internal/stats` — normalizes Docker's raw streaming stats into the
  wire-format `Frame`: correct CPU% (delta-based, expressed against host
  cores), memory usage with page-cache subtracted (the single most common
  bug in naive Docker stats displays), summed network counters.
- `internal/auth` — offline Ed25519 JWT verification for panel-signed
  capability tokens (algorithm pinned to EdDSA only — rejects `alg:none`
  and HMAC/algorithm-confusion forgeries, checked by dedicated security
  tests) plus constant-time node-token comparison for machine-to-machine
  REST calls.
- `internal/api` — the HTTP + WebSocket control surface: REST
  `GET /api/servers/{uuid}` and `POST /api/servers/{uuid}/power`
  (node-token authenticated), and `GET /api/servers/{uuid}/ws` — the
  browser's **direct** connection for console + stats, authenticated by
  the capability token as the connection's first frame, exactly per the
  documented protocol (`auth` → `auth:ok` → `console:output` / `stats` /
  `status` pushed, `console:send` / `power:set` accepted, mid-session
  re-auth support, `token:expiring` / `token:expired`).
- `internal/config` — local JSON/YAML-free loaders for a node profile and
  server definitions, plus the M2 fields (`node_uuid`, `node_token`,
  `listen_addr`, `panel_public_key_path`). Still a stand-in for the full
  bootstrap flow that lands once the panel exists.
- `cmd/pxagent` — the CLI: `network ensure`, `server
  create|start|stop|kill|rm|inspect` (M1), and `serve` (M2) — starts the
  HTTP/WS API, optionally registering and auto-starting one or more
  servers, adopting an already-running container by name if one exists
  (a small preview of the full boot-reconciliation sweep that lands in M3).
- `configs/seccomp-pxhost.json` — generated from Docker's own upstream
  default profile (`hack/gen-seccomp`) by unconditionally stripping a
  denylist of dangerous syscalls, on top of the `CapDrop: ALL` that already
  makes most of them unreachable.
- `hack/devtoken` — mints Ed25519 keypairs and signed capability tokens for
  local testing; a tiny slice of the "fake-panel harness" the architecture
  doc calls for. **Never build this into a production image.**
- `hack/wsclient` — a minimal WS test client standing in for a browser (or
  `websocat`) to exercise the console/stats protocol end-to-end.
- `hack/attachtest` — isolates raw Docker attach/write/read behavior for
  debugging, independent of the agent's own session plumbing.

Not yet implemented (later milestones per the roadmap): the Docker event
listener + `starting→running` promotion from a real "ready" log marker
(currently `Start` marks `running` immediately after a successful Docker
start call), boot-time reconciliation, the filesystem jail, backups, the
full YAML config + mTLS bootstrap flow, and crash-restart budgets.

## Two real bugs found while smoke-testing this milestone

Both are the kind that only show up talking to a real daemon — worth
knowing about if you're extending this code:

1. **`ListenAndServe(addr)` silently bound to `:80`.** The method accepted
   an `addr` parameter but never assigned it to the underlying
   `http.Server.Addr`, so Go fell back to its net/http default. Fixed in
   `internal/api/server.go`; regression-tested in `server_test.go`.
2. **Console input written via a REST-triggered power action went
   nowhere, with no error.** `srv.Server.Start` was attaching the console
   pump using the *caller's* context — the HTTP request's or the WS
   frame's — which is cancelled almost immediately after the triggering
   call returns. The long-lived attach connection needs to outlive that.
   Fixed by always attaching on `s.bgCtx` (a context tied to the server's
   whole lifetime), and, as a second, independent fix, by making
   `console:send` and `power:set` perform their actual Docker I/O in a
   background goroutine rather than inline in the WS session's single
   event loop — a slow/blocked write or a slow power action (stop can
   legitimately take up to the configured timeout) must never stall stats
   or console delivery on that same connection. Also caught in the
   process: a hand-rolled `json.NewDecoder` over the WS library's message
   `Reader` can leave a message "not fully read" from the library's
   point of view even after successfully decoding it, breaking the next
   read — switched to the library's own `wsjson.Read`/`Write` helpers.

## Running the unit tests

```
go test ./...
```

Every package's suite runs in well under a second and requires no Docker
daemon — including the JWT verifier's algorithm-confusion and `alg:none`
forgery tests, and the WS server's address-binding regression test (which
spins up a real `net.Listener` on `127.0.0.1` but talks to no external
service).

## Trying it end-to-end against a real Docker daemon

Any Docker Engine works, including Docker Desktop's Linux VM on Windows —
useful for iterating locally before a dedicated Linux node/VM is available
for the full security posture (AppArmor, real cgroup IO weight, etc., which
Docker Desktop's VM does not fully support — see `io_weight_supported` in
the node config).

```
go build -o bin/pxagent ./cmd/pxagent
go build -o bin/devtoken ./hack/devtoken
go build -o bin/wsclient ./hack/wsclient
# (add .exe to every binary name on Windows)

# One-time: an Ed25519 keypair standing in for the panel's signing key.
./bin/devtoken keygen --out-dir hack/smoketest/keys

# The container's data directory must exist and be owned by the server's
# uid before creation — in the full agent this is fsx's job (later
# milestone); for now, pre-create it by hand or with a throwaway container.

# Start the agent's HTTP/WS API, creating+auto-starting one demo server:
./bin/pxagent serve --node hack/smoketest/node.json \
  --server hack/smoketest/server2.json --autostart

# In another shell: mint a token and drive the console over WebSocket.
TOKEN=$(./bin/devtoken mint --key hack/smoketest/keys/panel-ed25519.key \
  --node <node_uuid from node.json> --server <uuid from server2.json>)
./bin/wsclient --url ws://127.0.0.1:8443/api/servers/<uuid>/ws \
  --token "$TOKEN" --command "hello pxhost console" --duration 6s
```

`hack/smoketest/{node,server2}.json` are a working example — `server2.json`
runs a plain `alpine` image with `cat` as the startup command, so anything
written to the console is echoed straight back on stdout, making the
round trip trivially visible. This is what was used to validate the
milestone's demo target end-to-end: connect, authenticate, send a console
command, see it echoed back through `console:output`, and receive live
`stats` frames — plus `power:set` (start/stop/restart/kill) both over the
WebSocket and via `POST /api/servers/{uuid}/power`.
