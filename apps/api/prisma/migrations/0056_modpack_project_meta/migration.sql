-- Per-project slug, name and CurseForge-declared required dependencies for
-- one install attempt; lets the auto-retry map a Forge crash back to
-- CurseForge projects and avoid skipping a mod other kept mods depend on.
ALTER TABLE "modpack_installations" ADD COLUMN "project_meta" JSONB;
