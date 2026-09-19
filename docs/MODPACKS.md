# Modpacks architecture and rollout

This document records the analysis that preceded the catalog implementation and the boundaries for the installation phases. It is intentionally incremental: the existing individual-mod upload/listing flow remains available throughout the rollout.

## Existing infrastructure to reuse

- The panel Add-ons page already models its individual-mod views as pluggable sources (`features/addons/sources`). Modpacks are a sibling content type, not a replacement for that flow.
- `ServerAccessService` is the mandatory tenant/RBAC/status gate for every server-scoped backend operation. Modpack routes use it instead of introducing another authorization path.
- Redis is already the shared cache. Provider search, project, version and metadata responses use namespaced TTL keys there.
- Large file traffic, filesystem changes and archive extraction belong to the Go Agent. The central API only authorizes and dispatches operations.
- Backups already have an API-to-Agent path, quota enforcement, audit events and customer activity events. Phase 2 should compose that path rather than implement another backup format.
- Template install data and server variables are the existing source of Docker image, startup command, loader and Minecraft version. A modpack installation must update these through the same server/template services.
- Runtime state is Agent-authoritative and separate from the panel provisioning status. Installation must wait for a confirmed offline process state before touching server files.
- The Agent already has jailed filesystem helpers and archive tests. Phase 2 must extend those helpers with modpack-specific size, entry-count, symlink and compression-ratio limits rather than extract archives directly in the API.

## Provider boundary

`ModpackProvider` normalizes search, project, release and metadata responses. The UI and controllers only consume normalized values and select a provider from a registry; provider-specific JSON remains inside its adapter.

The Phase 1 Modrinth adapter uses the official v2 API, an identifying User-Agent, bounded timeouts, one safe retry for GET requests, explicit 429 handling and Redis TTLs. The CurseForge adapter will implement the same contract and keep its API key exclusively in the backend.

## Rollout

### Phase 1 — catalog and Modrinth (implemented)

- Search, filters, source selector, sorting and bounded pagination.
- Cards and a details modal with project metadata and releases.
- Minecraft/loader/release selections are derived from actual release combinations.
- New server permission keys for catalog, install, update and remove.
- Install remains disabled until the Agent pipeline exists; no unsafe archive extraction shortcut is present.

### Phase 2 — transactional Modrinth installation

- Add a persisted installation operation with `pending`, `downloading`, `installing`, `configuring`, `completed`, `failed` and `rolling_back` states.
- Dispatch a compact manifest to the Agent; the Agent downloads only allowlisted Modrinth/CDN URLs and validates the provider hashes.
- Stop and confirm process termination, optionally create a normal server backup, preflight disk space, safely inspect/extract the `.mrpack`, resolve server-required files, update loader/template/startup data and restart only after validation.
- Stream real byte/stage progress from the Agent. On failure, retain diagnostics and expose restore when a backup exists.
- Security limits must cover canonical-path confinement, symlink rejection, archive entry/expanded-size/compression-ratio limits, per-file and total download limits, content-length mismatch, checksum failure and insufficient disk.

### Phase 3 — CurseForge

- Add `CurseForgeProvider` to the registry and configure its secret only in the API/Agent environment.
- Respect per-file distribution permissions. A blocked file produces a clear actionable result; it is never scraped or bypassed.
- Provider failures remain isolated so Modrinth continues to work.

### Phase 4 — installed history and updates

- Persist installed source/project/release/game/loader data and installation timestamps.
- Resolve compatible newer releases on demand, show changelog data when supplied, and require explicit user approval.
- Reuse the Phase 2 backup/rollback pipeline and preserve worlds only when the transition is declared safe.
- Record install, update, remove, failure and restore in both audit and customer Activity feeds.
