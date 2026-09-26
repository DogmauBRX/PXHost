-- CurseForge mods whose authors disallow third-party downloads are skipped
-- during install; this records them so the client can add them manually.
ALTER TABLE "modpack_installations" ADD COLUMN "manual_files" JSONB;
