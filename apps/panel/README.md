# PXHost Panel (Web)

Vite + React + TS. See [../../docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) section 5
for the full design.

## Status: Admin/Client separation (multi-tenant platform split)

Goal: evolve from one shared authenticated area into two genuinely
separate environments — `/admin` (operator, sees everything) and
`/client` (customer, sees only their own) — with real backend isolation,
not just hidden UI. The investigation that preceded this work found the
isolation itself already correct: `ServerAccessService.resolve()` plus
Postgres RLS (`can_access_server()`) already returned an identical 404 for
"doesn't exist" and "not yours," and `AuthenticatedUser.isAdmin` was
already re-derived from the database on every request, never trusted from
the JWT. The actual gaps were narrower than the request implied:

- **`ServerAccessService.resolve()` had no admin path.** An admin
  literally could not open console/files/backups for a server they didn't
  own — every client-facing service called `resolve()` with only the
  caller's own id, and the owner/subuser branches were the only ones that
  existed. Fixed by adding a third branch, gated on `isAdmin` (never a
  route param — always the guard-derived boolean), that fetches under
  `withRLS({ isAdmin: true })` and grants `can: () => true` unconditionally
  (suspension gating deliberately doesn't apply to admin — inspecting and
  reviving a suspended server is the operator's job). Threaded through
  `files`, `backups`, `schedules`, `databases`, `subusers`, `activity`,
  and `client-servers` — every `withRLS({ userId, isAdmin: false })`
  internal to those six services became `{ userId: actor.id, isAdmin:
  actor.isAdmin }`, so a resolved admin session doesn't get silently
  RLS-filtered back down to zero rows one call later. `subusers.service.ts`
  additionally needed its three `role !== 'owner'` checks widened to admit
  `'admin'`, since subuser management was intentionally owner-only and an
  admin's resolved `role` is `'admin'`, not `'owner'`.
- **No admin CRUD for users at all.** `UsersService` was read-only by a
  prior milestone's deliberate scope cut — no create, no edit, no
  block/unblock existed anywhere, backend or frontend, despite being
  explicitly requested. Added `POST /api/admin/users`,
  `PATCH /api/admin/users/:id`, `POST /api/admin/users/:id/{block,unblock}`
  — blocking takes effect on the very next request with no token
  invalidation needed, since `JwtAuthGuard` already re-checks `isActive`
  fresh from the database every time.
- **No admin server power control, no admin server detail page.** Solved
  together: rather than building a parallel admin-only files/backups/power
  API surface, the SAME `/api/client/servers/:id/*` routes now serve an
  admin caller too (via the `resolve()` bypass above) — the admin
  drill-down page (`/admin/servers/$serverId/*`) reuses the exact same
  `ConsolePage`/`FileManager`/`BackupsPage`/etc. components the customer
  area uses, with an owner-context banner ("Cliente: … · Plano: … ·
  Node: …") prepended.

Two backend `include` additions, no migration: `ServersService.list/get`
now selects `owner: { id, username, email }`;
`ServerAccessService.listAccessible` now selects `template` and
`allocations` so the customer's server cards can show game/IP:port instead
of just node name and memory.

Frontend: `nav.config.ts`'s single `NAV_SECTIONS` (filtered by an
`adminOnly` flag) became two real arrays, `ADMIN_NAV_SECTIONS` and
`CLIENT_NAV_SECTIONS` — `AppShell` takes an `area: 'admin' | 'client'`
prop and resolves sections/panel-label/settings-target from it, rather
than one sidebar hiding half its own items. Post-login routing reads
`globalRole` directly (`!== 'user'` → `/admin`, else `/client`) — no
manual picker. `/` became a permanent `beforeLoad`-only dispatcher rather
than a page, so old bookmarks keep working. New `/client/*` route tree
(dashboard, servers list, the full 7-tab per-server layout, settings,
plus honest `Plano`/`Faturamento`/`Suporte` pages — the latter two are
real "em breve" placeholders, not fake data, since no billing or
ticketing system exists in this codebase). A brand new `/admin/system`
page surfaces two backend modules that had zero UI before this: JWKS
signing-key rotation and log-partition maintenance, plus `/readyz`
(already public, already existed) for a Postgres/Redis health strip.

**One real routing bug found live, same class already documented in this
file for `servers.$serverId.tsx`:** `admin.servers.tsx` (the flat server
list, no `<Outlet/>`) became an *implicit layout* the moment
`admin.servers.$serverId.tsx` was added as a sibling — TanStack Router's
flat-file convention treats a bare `admin.servers.tsx` as the parent of
anything nested under that path once such a file exists. The URL updated
correctly on navigation, but the list kept rendering with nowhere for the
child route to go. Fixed the same way the original bug was fixed:
renamed to `admin.servers.index.tsx`, an explicit index leaf that can't
accidentally become a layout. Caught by clicking into a real server in
the actual browser, not by inspection — the failure mode (URL right,
content wrong) doesn't show up in `tsc` or in a route-tree diff.

**Run for real, full stack:** created two live client accounts
(`cliente-teste`, `cliente-b`) via the new admin UI, one server each on
`demo-node-1`, and ran the isolation battery directly against the running
API: client A got a real 404 on every one of B's resources (detail,
console-token mint, files, backups, power, schedules, subusers,
databases, activity) and a real 403 on every `/api/admin/*` route; the
admin session got a real 200 on all of B's DB-backed resources through
the *same* endpoints client A was just denied on. Blocking `cliente-teste`
through the real UI, then attempting to log in as them via `curl`,
correctly returned 401 immediately — confirmed the block takes effect
without any session/token cleanup step. Logged in as each role through
the real browser: admin lands on `/admin` with the "ADMIN PANEL" label,
client lands on `/client` with "CLIENT PANEL" and sees only their own
server (template, IP:port, node, memory — nothing of B's). The admin
drill-down for that same server showed the correct owner banner and the
real console/power controls, reusing the identical component the
customer's own console page uses. `tsc` + oxlint clean on the panel,
`tsc` clean on the API, 44 unit tests + all 98 e2e tests green
(including `rls.e2e-spec.ts` and `client-servers.e2e-spec.ts`, both
exercising exactly the cross-tenant paths this milestone touched) after
every change, not just at the end.

## Status: M14 — Billing hooks (final roadmap milestone; no new panel bugs)

Milestone DoD (architecture doc roadmap): **external payment event
idempotently suspends/restores a server.** The payment provider talks
directly to the API (`POST /api/billing/webhook`), never through this
panel — this repo's only role is giving an admin the manual equivalent
of what a webhook does automatically.

- **`src/features/admin/AdminServersPage.tsx`** (from M13) gained a
  Suspender/Reativar button per server — Suspender only when NOT already
  suspended (asks for a reason via `prompt()`, required, matching
  `SuspendServerDto`'s validation), Reativar only when it is. The status
  label already showed "Suspenso" from M13's `STATUS_LABELS` map with no
  change needed.

No new panel bug found this milestone. Same live-testing note as M13's
own record for `confirm()`: this project's Claude Browser automation
tooling auto-dismisses native `prompt()` dialogs too, so Suspender's
click in the browser never completes the flow end-to-end through
automation. The Reativar path (no dialog) WAS verified through the real
UI end to end — clicking it against a genuinely suspended live server
correctly called the real API and the server's status flipped to
`ready`, confirmed independently afterward, not assumed from the UI's
own optimistic state. Suspender's wiring, the prompt copy, and the
underlying `POST /api/admin/servers/:id/suspend` call were verified by
exercising the identical endpoint directly (see
`../../agent/README.md`'s M14 section for that full live run) — the same
resolution M13 reached for `confirm()`, for the same tooling reason, not
a reason to make a genuinely destructive action skip confirmation.

**Run for real, full stack:** `/admin/servers` correctly showed a real
suspended server's status as "Suspenso" with a Reativar button in place
of Suspender, and clicking it through the real browser genuinely
restored the server (`status: 'ready'` confirmed via the API
immediately after, not just the UI's own state). Panel `tsc` + production
build both clean afterward.

## Status: M13 — Hardening & operations (no new panel bugs; transfer + rotation UI proven live)

Milestone DoD (architecture doc roadmap): **live node-to-node transfer
with no data loss; token rotation; log partition automation.** Scoped to
Panel + API + Agent; this repo's share is two small additions to the
admin console rather than a new page-per-feature — partition automation
in particular has no UI at all (a daily background job + one manual
admin trigger button was judged sufficient; nobody needs a dashboard for
"did today's partition exist," see `../api/README.md`).

- **`src/features/admin/AdminServersPage.tsx`** (new, routed at
  `/admin/servers`) — every server, a target-node picker, a Transferir
  button (disabled unless the server is `ready` — matches the gating
  table's own rule that `transferring` blocks further mutation), and a
  per-server transfer history panel (`refetchInterval: 3000`, so
  `pending→archiving→uploading→restoring→success` is visible live
  without a manual refresh).
- **`src/features/admin/NodesPage.tsx`** gained a "Rotar token" button
  next to the existing bootstrap-token one — the admin-forced
  compromise-response path (architecture doc roadmap M13), reusing the
  SAME response shape and reveal-once display the bootstrap flow already
  has, since `forceRotate` returns exactly what `issueBootstrapToken`
  does. Guarded by a `confirm()` (killing a node's live credential is
  disruptive — the node goes unreachable until manually re-bootstrapped)
  — which turned out to matter for HOW this got verified below, not just
  as UX.

No new panel bug found this milestone. One live-testing note worth
recording even though it isn't a panel defect: this project's Claude
Browser automation tooling auto-dismisses native `confirm()`/`alert()`
dialogs rather than accepting them, so the "Rotar token" button's click
in the browser never actually fired the underlying request — confirmed
via the network log (no request recorded) rather than assumed. The
button itself, the confirm copy, and the wiring were all still verified
by inspection and by exercising the identical `POST
/api/admin/nodes/:id/rotate-token` call directly — this is a testing-tool
limitation, not a reason to remove the confirmation the real UI
correctly asks a real admin for.

**Run for real, full stack:** `/admin/servers` correctly listed a real
server provisioned via the API, and initiating a transfer through the
UI's own Transferir button produced a real `server_transfers` row
(confirmed via the API directly afterward, not assumed from the UI's
optimistic state) that the worker picked up and drove through the real
pipeline — see `../../agent/README.md` for the full live-run narrative
(the archive, the fetch, the marker-file integrity check, the container
landing on the new node). `/admin/nodes`' node list correctly showed
both real nodes as Online throughout, including through a real
admin-forced token rotation and recovery cycle. Panel `tsc` + production
build both clean afterward.

## Status: M12 — Admin console (no new bugs; the full onboarding flow proven live, UI-only)

Milestone DoD (architecture doc roadmap): **onboard a new node and a new
game from the UI only; plan-apply dry run works.**

- **`src/app/guards.ts`** — `requireAdmin()`, a client-side route guard
  (the real gate is the API's existing `AdminGuard`; this is purely UX —
  no flash of admin UI for a non-admin before the API 403s).
- **`src/ui/layout/AppShell.tsx`** — a conditional "Admin" nav link for
  `global_role === 'admin'` users.
- **`src/features/admin/`** (all new) — `LocationsPage`, `NodesPage`
  (with a `NodeAllocations` sub-component for issuing bootstrap tokens
  and managing port ranges inline), `TemplatesPage` (with a
  `TemplateVariables` sub-component), `PlansPage` (with a `PlanEditor`
  sub-component: edit resources → `Ver dry run` → drift report → `Aplicar`
  → apply-result summary, all inline on the same card, matching the
  dry-run-then-apply flow architecture doc 4.5 describes).
- Routes: `admin.tsx` (layout, `requireAdmin`-gated), `admin.index.tsx`
  (Locations), `admin.nodes.tsx`, `admin.templates.tsx`, `admin.plans.tsx`.

No new bug found this milestone — every admin form (location, node,
allocation, template group, template, variable, plan, plan edit) worked
correctly against the real API on first use during the live run below.

**Run for real, full stack, nothing pre-seeded:** logged in as the real
admin account and confirmed `/admin` renders with Locations active by
default. Created a new Location, a new Node in it (issuing a real
one-time bootstrap token through the "Emitir bootstrap token" dialog —
the real `pxagent` binary redeemed it outside the browser, see
`../../agent/README.md`), and once the node reported back online, added
its port allocations, all through plain form submissions. Created a new
Template Group and a Template inside it (Docker image, startup command,
install script) plus one template variable through `TemplateVariables`'
inline add/remove UI. Created a new Plan. All four list views correctly
reflected each creation immediately (React Query cache invalidation on
every mutation). With a real server provisioned onto the new node (via
the admin servers API — server creation itself has no dedicated panel UI
yet, out of this milestone's scope) and running, opened the Plan's editor,
changed CPU/memory, clicked "Ver dry run" and saw the correct
one-server drift entry with real before→after values, then clicked
"Aplicar a 1 servidor(es)" and got back "1 servidor(es) atualizado(s)" —
confirmed against `docker inspect` (see `../../agent/README.md`) that the
real running container's limits actually changed, live, with no restart.
See `../api/README.md` for the API-side half of this same run.

## Status: M11 — Subusers, granular RBAC, activity feed

Milestone DoD (architecture doc roadmap): **invited friend can restart
but not delete backups; every mutation attributed in the feed.**

- **`features/subusers/SubusersPage`** — invite by e-mail (must already
  have an account — no self-registration exists yet) with a permission
  checklist rendered straight from `GET /api/client/permission-catalog`
  (real seeded data, grouped by `groupKey` — never a hand-maintained
  list that could silently drift from what the backend actually
  enforces), per-subuser "Editar permissões," and Remover.
- **`features/activity/ActivityPage`** — a flat, newest-first feed with
  a small hardcoded label map for known event names (falls back to the
  raw event string for anything unmapped, so a future event type never
  renders as literally blank) and each entry's actor.
- New `Subusuários`/`Atividade` tabs alongside the existing five.
- **`PowerControls`** — `permissions` (resolved from the WS auth
  response, i.e. the REAL grant a subuser's capability token carries,
  not a guess) now actually gates which buttons a subuser can click at
  all, not just whether the backend accepts the request.

### One real bug found (live — a real permission-scoped account clicking a real button)

16. **The Reiniciar (restart) button checked the WRONG permission** —
    `disabled={!canStop || !has('stop')}`, copy-pasted from the Parar
    button one line below it, when it should check `has('restart')`.
    Effect: a subuser granted `control.restart` but NOT `control.stop`
    (exactly the DoD's own example) saw Reiniciar disabled even though
    they were fully authorized to use it — and, the mirror-image bug
    nobody happened to test for, a subuser granted `control.stop` but
    NOT `control.restart` would have seen it wrongly ENABLED. The
    backend was never at risk either way (`ClientServersService.power`
    and the agent's own WS handler both check the real permission key
    independently — this was a UI-only gate), but it would have made the
    DoD's own example impossible to complete through the actual UI.
    Found live: invited a real second account with exactly
    `control.restart` (no `control.stop`), logged in as that account,
    and the Reiniciar button was disabled. Fixed the one-character
    permission-key typo; re-verified live in the same session — the
    identical account, no other change, now sees it enabled, clicks it,
    and the real Docker container actually restarts.

**Run for real:** created two real accounts, invited the second as a
subuser scoped to exactly `control.restart` + `backup.read` from this
exact UI, logged in as that account (same browser, sequential logins —
the refresh cookie is shared per origin, so two simultaneous tabs would
have silently fought over the same session), clicked the real Reiniciar
button and confirmed a real container restart, then confirmed Excluir
(delete) on a real backup correctly failed with a real `403` from the
backend even though the button itself doesn't yet grey out for a
permission a subuser lacks (a UI polish gap noted for later — the
security boundary is server-side either way, already proven). Read the
Atividade feed afterward as the owner and confirmed every action above
was attributed to the account that actually performed it. See
`../../agent/README.md` and `../api/README.md` for the rest of this run,
including the activity-feed gap for WS-driven actions found in the same
session.

## Status: M10 — Schedules

Milestone DoD (architecture doc roadmap): **nightly restart+backup runs
unattended, respects timezone and node-offline skip, never double-fires.**
The panel's half is the CRUD surface a customer uses to set that up —
the actual unattended execution lives entirely in the new API worker
process (see `../api/README.md`).

- **`features/schedules/SchedulesPage`** — create form (name, hour,
  minute — day/month/day-of-week stay `*`, matching the DoD's "nightly"
  scope rather than exposing the full 5-field cron grammar in v1), an
  "only run if online" checkbox, and per-schedule task management
  (`+ Reiniciar` / `+ Backup` buttons, remove per task) plus an
  active/inactive toggle and delete. Shows next/last run time and the
  last run's outcome (Sucesso/Falhou/Ignorado) directly from the
  schedule row — no separate "run history" surface in v1.
- New `Agendamentos` tab alongside Console/Arquivos/Backups/Bancos de
  dados on the server layout route.

No new panel-side bug this milestone — the UI worked correctly against
the real API on the first live run. The two real findings this milestone
(a schema-vocabulary mismatch caught by the API's own e2e suite before
shipping, and a genuine pre-existing Node Agent bug found only because
this milestone drove a real unattended restart end to end) were both
outside the panel; see `../api/README.md` bugs #17–18 and
`../../agent/README.md` bug #16.

**Run for real:** created a schedule from this exact UI against a real
server, added a backup task and a restart task, watched the real
background worker (a separate process, `pnpm start:worker`) pick it up
on its next 30-second tick and actually run both — confirmed by a real
`.tar.gz` backup file appearing on the agent's disk, not just a UI
refresh. Separately confirmed the "only run if online" checkbox's effect
live: with the node marked offline, the scheduled run was skipped
entirely, with zero calls ever reaching the agent. See
`../../agent/README.md` and `../api/README.md` for the rest of this run.

## Status: M9 — Databases

Milestone DoD (architecture doc roadmap): **plugin connects with created
credentials; server deletion drops the schema+user.** The panel's half is
entirely the client-facing surface — registering a database HOST is an
admin operation with no dedicated admin UI yet (every admin resource so
far — nodes, locations, plans, templates — is API-only until M12's admin
console; database hosts follow the same convention).

- **`features/databases/DatabasesPage`** — list (host, database,
  username@remote, created date — never the password), a `Criar banco de
  dados` button with an optional name field, and a one-time credentials
  reveal panel after creation (host, database, username, password) with
  an explicit "Ok, anotei" acknowledgement — the password is never
  fetchable again after this response, matching the bootstrap-token
  disclosure pattern already used for node onboarding.
- New `Bancos de dados` tab alongside Console/Arquivos/Backups on the
  server layout route.

No new panel-side bug this milestone — the two real bugs found while
building M9 (RLS-bypassed queries in the new `DatabasesModule`, and a
pre-existing gap where M8's backup quota was never enforced) were both
API-only; see `../api/README.md` bugs #15–16.

**Run for real:** created a database from this exact UI against a real
server and a real MariaDB host, read the one-time credentials panel, then
connected with those precise values from an independent `mariadb` client
— not the panel, not root — and ran real DDL/DML. Deleted it from the
same UI's Excluir button and confirmed the list correctly went back to
"Nenhum banco de dados ainda." See `../api/README.md` for the rest of
this run, including the server-deletion half (no panel UI for that yet —
admin server deletion is API-only in M9, same as every other admin
operation).

## Status: M8 — Backups

Milestone DoD (architecture doc roadmap): **create a backup, download it,
restore it, files come back correctly; restoring a backup while the
server is running is rejected with a clear message.** All four verified
live in a real browser this milestone, not just via unit/e2e tests.

- **`features/backups/BackupsPage`** — list with size/date, Baixar
  (mints a link, then a plain `<a>` click — same "not `fetch()`, so no
  CORS involved" reasoning as M7's file download), Excluir
  (`window.confirm`), and a typed-confirmation Restaurar flow: the button
  stays disabled until the literal string `RESTAURAR` is typed into an
  adjacent field, matching the architecture doc's "irreversible, make it
  hard to fat-finger" posture for an action that overwrites every file on
  the server.

### One real bug found this milestone (root cause and fix live in `../api/README.md` bug #14)

15. **Restoring a backup while the server was running showed the raw
    agent error JSON instead of the friendly confirmation-panel message
    `BackupsPage.tsx` was already written to show.** The component's own
    logic (`err.status === 409 ? 'O servidor precisa estar parado...' :
    ...`) was correct from the moment it was written — the bug was
    entirely on the API side, which was reporting every agent error as a
    generic `503` and losing the `409` the agent actually sent. Found by
    clicking Restaurar on a server the Console tab showed as RUNNING and
    seeing `Agent returned 409: {"error":{"code":"SERVER_NOT_STOPPED"...`
    render verbatim instead of the Portuguese message. No panel-side code
    changed — confirmed fixed by re-running the identical
    type-RESTAURAR-and-click flow in the same browser tab once the API's
    `agent-client.service.ts` fix (see the API README) had hot-reloaded:
    the friendly message rendered on the second attempt.

**Run for real:** logged in, opened a real server's Files tab, edited
`install.marker` to a known marker string, switched to the Backups tab,
created a backup (`Criar backup`, confirmed in the list with a real size
and timestamp), went back and changed the marker to a different string,
returned to Backups and clicked Restaurar while the server was RUNNING
(rejected — see bug #15 above), started the server's Parar via the
Console tab (confirmed offline via the API), retried the identical
Restaurar → type `RESTAURAR` → confirm flow — this time it succeeded, and
the marker file was confirmed back to its ORIGINAL content by reading it
directly off the agent's disk, not just trusting the UI showing no error.
Also minted and clicked a real Baixar download link (the browser's own
network log showed a real `200` from the agent, with the sandbox's
download-save step aborting as expected — the signed, single-use token
itself was proven consumed by a manual replay attempt correctly being
rejected). See `../../agent/README.md` and `../api/README.md` for the
rest of this run.

## Status: M7 — File manager

Milestone DoD (architecture doc roadmap): **edit `server.properties`
in-browser, restart, see it in-game; `../` escape rejected; 2 GB upload
works.** The route restructure below and one CORS bug were both found by
actually clicking through this in Chrome — neither would show up in a
type-check or a unit test.

- **`src/app/routes/servers.$serverId.tsx`** is now a proper layout route
  (breadcrumb + a Console/Arquivos tab nav + `<Outlet/>`), with the
  console and file manager as its `index.tsx` and `files.tsx` children.
  Found live: a route file named `servers.$serverId.files.tsx` nests
  UNDER `servers.$serverId.tsx` in TanStack Router's flat-file
  convention — without an `<Outlet/>` in the parent, navigating straight
  to `/servers/:id/files` silently rendered the CONSOLE page instead
  (the URL bar was correct; the parent route just had no slot for its
  child to render into, so it always "won").
- **`features/files`** — `FileManager` (breadcrumb navigation, list,
  upload via a hidden `<input type="file">`, download via a plain
  `<a>` click — deliberately NOT `fetch()`, since a real download/
  navigation isn't subject to CORS at all, unlike upload's `fetch()` call
  which needs to read `{bytesWritten}` back), `FileEditor` (a plain
  `<textarea>` — no code-editor dependency for M7 — with a dirty-guard
  via `beforeunload` and an explicit confirm before closing with unsaved
  changes).

### One real bug found (real browser, real cross-origin fetch — see `../api/README.md` for the fix)

14. **Saving an edited file always failed with a CORS error**, even
    against a correctly-authenticated, correctly-routed request:
    `Access to fetch ... has been blocked by CORS policy: Method PUT is
    not allowed by Access-Control-Allow-Methods in preflight response.`
    The panel API's CORS config never explicitly listed `methods` — see
    `../api/README.md` bug #13 for the root cause and fix. Confirmed
    fixed by re-running the exact same edit-and-save flow in the same
    browser tab after the API hot-reloaded: the edited content was
    verified on disk afterward, not just "no error shown."

**Run for real:** logged in, opened a real server's file list, saw the
real `server.properties` an install script had actually written, opened
it in the editor, edited it, saved — confirmed both via the API's own
read-back and by `cat`-ing the file directly on the agent's data
directory. Minted and used a real signed download link and a real signed
upload link directly against the running agent.

## Status: M6 — Panel MVP (end-to-end vertical slice complete)

The first user-facing surface. Milestone DoD (architecture doc roadmap):
**login → server list → start → console reaches "Done" → send a command →
live CPU/RAM move.** All verified live, in a real browser, against the
real panel API and the real compiled Go agent — not mocked, not just unit
tests.

- **Stack**: TanStack Router (file-based, typed `beforeLoad` guards),
  TanStack Query v5, Zustand (auth store only — the console/stats path
  deliberately avoids React state entirely, see below), React Hook Form +
  Zod, Tailwind v4 with CSS-variable tokens (dark-first).
- **`src/app`** — router setup, file-based routes (`/login`, `/`,
  `/servers/$serverId`), the `requireAuth` beforeLoad guard.
- **`src/shared/api`** — `apiFetch`: attaches the in-memory access token,
  retries once through a shared (de-duplicated) `/api/auth/refresh` on a
  401, then hard-redirects to `/login`. `bootstrapAuth` re-establishes a
  session from the refresh cookie on every page load, since the access
  token itself is memory-only per architecture doc 5.3.
- **`src/shared/realtime/useServerSocket`** — the reconnect state machine
  (`idle→connecting→authenticating→open→reconnecting→failed`),
  exponential-jittered backoff, suppressed while the tab is hidden >60s,
  retried on `visibilitychange`/`online`. Console output is written
  directly into the `xterm.js` instance and stats directly into `uPlot`
  via a ring-buffer `useRef` — **zero React re-renders per second** on the
  console page, exactly as architecture doc 5.2 specifies.
- **`src/features/console`** — `Terminal` (xterm, `disableStdin: true`,
  a separate `<input>` for commands), `StatsChart` (uPlot, CPU% + RAM MB
  on dual scales), `PowerControls` (two-click confirm on kill).

### The live run

A real node was bootstrapped (same handshake as M4/M5), a real owner
account created, a real server provisioned (M5's flow) running `alpine`
with `cat` as the startup command — chosen deliberately, same as M2's own
smoke test, because `cat` echoes stdin straight back to stdout, making
the round trip trivially visible in the console. Then, in an actual
Chrome tab:

1. Logged in with real credentials — real JWT issued, real `HttpOnly`
   refresh cookie set.
2. Server list showed the real server, RLS-scoped to its owner (a second
   account correctly saw nothing).
3. Opened the console — real Ed25519-signed capability token minted by
   the panel API, real direct WebSocket to the agent, real `auth`/
   `auth:ok` handshake.
4. Clicked **Iniciar** — real `power:set` over the socket, status flipped
   to `RUNNING`, real live CPU/RAM readout streaming from the real
   container's stats.
5. Typed a command and sent it — echoed back by the real `cat` process,
   appearing in the terminal exactly once.
6. Clicked **Parar** — real Docker stop (SIGTERM, then SIGKILL after the
   grace period since `cat` doesn't trap SIGTERM), status correctly
   settled to `OFFLINE` once the container actually exited.
7. Hard-reloaded the page mid-session — session survived via the refresh
   cookie, landed back on the dashboard without a re-login.

### Four real bugs found (all via the live run — none caught by `tsc` or a unit test)

1. **The refresh cookie could never actually be read back by a real
   browser, in dev OR production.** `apps/api`'s `AuthController` named it
   `__Host-panel_refresh` but scoped it to `Path=/api/auth` — the
   `__Host-` prefix mandates `Path=/` with zero exceptions, so a real
   browser silently drops the `Set-Cookie` header outright. `curl` and
   Fastify's `app.inject()` don't enforce cookie-prefix rules at all,
   which is exactly why every prior e2e test (M3 onward) passed cleanly
   while this was broken the whole time — this milestone's real-browser
   verification is what first exercised the actual browser cookie jar.
   Fixed in `apps/api` by renaming to `__Secure-panel_refresh` (which only
   requires the `Secure` attribute, not `Path=/`) and always setting
   `Secure: true` — browsers treat `http://localhost` as a secure context
   for this purpose, so dev works unchanged.
2. **Minting a console token always 400'd.** `apiFetch` unconditionally
   set `Content-Type: application/json` but sent no body for a bodyless
   POST — Fastify's JSON body parser rejects an empty body under that
   header outright ("Body cannot be empty..."). Fixed by defaulting the
   body to `'{}'` for any non-GET/HEAD request that doesn't supply one.
3. **Every console showed duplicated output** — scrollback and any sent
   command both appeared twice. `useServerSocket`'s async `connect()` had
   no staleness guard: React 18/19 StrictMode's dev-mode
   mount→unmount→remount cycle let a first, already-"cleaned-up"
   `connect()` call finish its `await mintConsoleToken(...)` and open a
   second, orphaned WebSocket nothing tracked or closed — still
   subscribed to the agent's console `Hub`, so every broadcast line
   arrived through both sockets. Fixed with a generation counter: each
   `connect()` captures the current generation and bails out (without
   opening a socket) if a cleanup has since bumped it.
4. **A reloaded console page could show `OFFLINE` for an already-running
   server**, then fail to start it ("already running"). The agent's power
   control (M2) is in-memory only — it never writes `power_state` back to
   the database — so a fresh page load had no way to learn the real state
   until a power action's own `status` event happened to fire. Fixed by
   also syncing the displayed state from the ambient `stats` frame's own
   `state` field, which the agent already pushes every 2 seconds
   regardless of any action.

## Local setup

```
pnpm install
pnpm dev       # http://localhost:5173 — needs apps/api running on :3000
```

`VITE_API_URL` (`.env`, default `http://localhost:3000`) points at the
panel API. `apps/api/.env`'s `CORS_ORIGIN` must match this app's origin
exactly (`http://localhost:5173` in dev) for the browser's CORS preflight
to succeed.

## Build

```
pnpm build     # tsc -b && vite build — route-based code splitting via
               # @tanstack/router-plugin's autoCodeSplitting
```

**Verified, all green:** `tsc -b` clean · production `vite build` succeeds
with per-route chunks · the full DoD flow (login → list → start → console
→ command → live stats → stop) run for real in Chrome against a real
Postgres-backed API and a real compiled `pxagent` — see the four bugs
above, all found and fixed during that same run.
