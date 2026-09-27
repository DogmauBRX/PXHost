-- Supports auto-retrying a CurseForge install when it fails because a mod
-- we deliberately skipped (client-only, or author-restricted) turns out to
-- be a hard dependency of another mod that declared it without scoping the
-- requirement to the client. See ModpacksService.maybeRetryCurseForgeInstall.
ALTER TABLE "modpack_installations" ADD COLUMN "extra_skip_project_ids" JSONB;
ALTER TABLE "modpack_installations" ADD COLUMN "skipped_project_ids" JSONB;
ALTER TABLE "modpack_installations" ADD COLUMN "file_slugs" JSONB;
ALTER TABLE "modpack_installations" ADD COLUMN "retry_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "modpack_installations" ADD COLUMN "retried_from_id" UUID REFERENCES "modpack_installations"("id");
