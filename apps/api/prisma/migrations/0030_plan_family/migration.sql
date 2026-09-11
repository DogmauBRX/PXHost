-- Checkout redesign (WHMCS-style) — lets two Plan rows that differ only
-- by billing cycle (e.g. "Básico mensal" / "Básico trimestral") be
-- presented as ONE product with a cycle switcher on the public
-- checkout, instead of two unrelated catalog entries.

-- ─────────────────────────────────────────────────────────────────
-- 1. New nullable column. Backfilled so every EXISTING plan becomes
--    its own single-member family — the public checkout renders
--    exactly as it did before this migration (one card, no cycle
--    switcher) until an admin deliberately gives two plans the same
--    planFamily. Zero behavior change on deploy.
-- ─────────────────────────────────────────────────────────────────
ALTER TABLE "plans" ADD COLUMN "plan_family" TEXT;
UPDATE "plans" SET "plan_family" = "slug" WHERE "plan_family" IS NULL;

-- ─────────────────────────────────────────────────────────────────
-- 2. Partial index — only non-deleted plans are ever grouped by
--    family (a soft-deleted plan's old family shouldn't affect a
--    live sibling's lookup), same "WHERE deleted_at IS NULL" pattern
--    other plan lookups in this codebase already use.
-- ─────────────────────────────────────────────────────────────────
CREATE INDEX "plans_plan_family_idx" ON "plans" ("plan_family") WHERE "deleted_at" IS NULL;
