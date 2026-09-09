-- Site-wide announcement banner — an admin-editable warning message
-- shown to every visitor (logged out on the public site AND logged in
-- on the panel). Single-row table: SiteAnnouncementService finds the
-- first row or creates a default (inactive, empty message) rather than
-- keying on a magic fixed id, same "find-or-create" posture
-- prisma/seed.ts already uses for the root admin. No RLS: like `plans`/
-- `nodes`, this is global catalog-shaped config, not per-tenant data.
CREATE TABLE "site_announcements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "message" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "site_announcements_pkey" PRIMARY KEY ("id")
);
