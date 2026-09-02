-- Client-features roadmap: advisory plan metadata surfaced to customers
-- on the dashboard, the server page, and /client/plan. Nullable
-- throughout — NULL means "this plan does not publish a recommendation,"
-- which renders as nothing rather than as a fake zero range. Deliberately
-- NOT copied onto `servers` (see PlansService's "snapshot, not reference"
-- rule): these describe the plan in prose, not a technical limit, so a
-- server can never "drift" from a recommendation the way it can from
-- memoryMb/diskMb/etc.

ALTER TABLE "plans"
  ADD COLUMN "recommended_players_min" INTEGER,
  ADD COLUMN "recommended_players_max" INTEGER,
  ADD COLUMN "recommended_mods_min"    INTEGER,
  ADD COLUMN "recommended_mods_max"    INTEGER,
  ADD COLUMN "recommended_plugins_min" INTEGER,
  ADD COLUMN "recommended_plugins_max" INTEGER,
  -- Display-only: clients cannot create servers today (only admins can),
  -- so there is no self-service flow for this to gate.
  ADD COLUMN "max_servers"             INTEGER;

ALTER TABLE "plans" ADD CONSTRAINT "plans_recommended_players_range_check"
  CHECK ("recommended_players_min" IS NULL OR "recommended_players_max" IS NULL
         OR "recommended_players_min" <= "recommended_players_max");
ALTER TABLE "plans" ADD CONSTRAINT "plans_recommended_mods_range_check"
  CHECK ("recommended_mods_min" IS NULL OR "recommended_mods_max" IS NULL
         OR "recommended_mods_min" <= "recommended_mods_max");
ALTER TABLE "plans" ADD CONSTRAINT "plans_recommended_plugins_range_check"
  CHECK ("recommended_plugins_min" IS NULL OR "recommended_plugins_max" IS NULL
         OR "recommended_plugins_min" <= "recommended_plugins_max");
ALTER TABLE "plans" ADD CONSTRAINT "plans_max_servers_check"
  CHECK ("max_servers" IS NULL OR "max_servers" >= 0);

-- Not RLS-protected: `plans` was never enabled for RLS (0002_rls_policies
-- — it's a global catalog like `users`/`locations`, not tenant data), so
-- these new columns need no policy work.
