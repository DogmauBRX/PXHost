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

The Modrinth adapter uses the official v2 API, an identifying User-Agent, bounded timeouts, one safe retry for GET requests, explicit 429 handling and Redis TTLs.

### CurseForge

The CurseForge adapter (`apps/api/src/modules/plugins/curseforge.provider.ts`) uses the approved 3rd-party API key (`CURSEFORGE_API_KEY`), which never leaves the Panel:

1. The Panel sends the Agent only the pack's official `downloadUrl` plus size/SHA-1.
2. The Agent downloads the `.zip`, validates archive limits and `manifest.json`, then calls `POST /api/remote/servers/:id/modpacks/curseforge/resolve` with the manifest's required `projectID`/`fileID` pairs. The Panel only answers while that server has an active CurseForge operation on the calling node, so a node token can't be used as a general download proxy.
3. The Panel resolves each file through `POST /v1/mods/files` and `POST /v1/mods`, returning the official `downloadUrl` and SHA-1. Resource packs (class 12), shaders (class 6552) and files tagged `Client` without `Server` in `gameVersions` come back as `skip` and are never installed on the server.
4. The Agent downloads each file into `mods/` (redirects restricted to `edge.forgecdn.net`/`mediafilez.forgecdn.net`), extracts the manifest's overrides folder, and reuses the same staging, backup and rollback path as `.mrpack` installs.

**Author distribution opt-out is respected.** When CurseForge returns `downloadUrl: null`, the author disallows third-party distribution. The Panel never builds a CDN URL by hand for these files: a restricted pack is shown as not installable. Restricted mods inside a pack are skipped, the rest is installed, and the list (name, filename, CurseForge file page) is stored in `modpack_installations.manual_files` so the panel tells the client exactly what to upload by hand. Real example: OreSpawn Adventure 3.0.2 has 54 files; 12 are client-only and 2 server-side mods (Subtle Effects, ServerCore) are restricted. Server packs (`isServerPack`) are hidden from the version list because they have no manifest.

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

### Phase 4 — installed history and updates

- Persist installed source/project/release/game/loader data and installation timestamps.
- Resolve compatible newer releases on demand, show changelog data when supplied, and require explicit user approval.
- Reuse the Phase 2 backup/rollback pipeline and preserve worlds only when the transition is declared safe.
- Record install, update, remove, failure and restore in both audit and customer Activity feeds.
