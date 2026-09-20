-- Found live testing NeoForge: `ServersService.createOnNode`/`ServerSetupService`
-- (complete/changeVersion) all pick the runtime image via
-- `Object.entries(template.dockerImages)[0]` — the FIRST key of that JSON
-- map. Every preset template's `docker_images` column still held the
-- legacy 4-way choice `{"Java 8": ..., "Java 17": ..., "Java 21": ...,
-- "Java 25": ...}` from before software-presets.ts was simplified to a
-- single `JAVA_IMAGE` entry — a stale row, never re-seeded (seed.ts only
-- seeds on a fresh database). Which key JSON/jsonb reports as "first" for
-- that map is not something either Postgres or this codebase actually
-- guarantees, and in practice a NeoForge server ended up pinned to
-- `java_17` — new enough for Minecraft 1.20.x itself, but too old for
-- NeoForge's OWN current FML bootstrap classes (classfile 69, i.e. Java
-- 25 — same class-version ceiling `JAVA_IMAGE`'s own comment already
-- documents for a recent Minecraft release), so the container crashed
-- outright with `UnsupportedClassVersionError` before Minecraft ever ran.
--
-- Fix: collapse every preset template's `docker_images` to the single
-- current entry (matching a fresh seed exactly), and bump every EXISTING
-- server on an older Java image up to java_25 — safe unconditionally
-- since a newer JRE always runs older bytecode fine (the same reasoning
-- `JAVA_IMAGE`'s own comment gives for using one shared, current image at
-- all).
UPDATE "server_templates"
SET "docker_images" = '{"Java 25": "ghcr.io/pterodactyl/yolks:java_25"}'::jsonb
WHERE "software_kind" IN ('paper', 'purpur', 'fabric', 'quilt', 'forge', 'neoforge', 'vanilla')
  AND "docker_images" ? 'Java 8';

UPDATE "servers"
SET "docker_image" = 'ghcr.io/pterodactyl/yolks:java_25'
WHERE "docker_image" IN (
  'ghcr.io/pterodactyl/yolks:java_8',
  'ghcr.io/pterodactyl/yolks:java_17',
  'ghcr.io/pterodactyl/yolks:java_21'
);
