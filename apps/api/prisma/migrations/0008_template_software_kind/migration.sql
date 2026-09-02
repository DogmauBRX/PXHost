-- Client-features roadmap: the one canonical software signal for a
-- template. `server_templates.features` (a String[] written once by the
-- seed as Pterodactyl-style UI feature flags and read nowhere) is left in
-- place but is NOT reused here — it answers a different question than
-- "what software does this run."

ALTER TABLE "server_templates" ADD COLUMN "software_kind" TEXT;

ALTER TABLE "server_templates" ADD CONSTRAINT "server_templates_software_kind_check"
  CHECK ("software_kind" IS NULL OR "software_kind" IN (
    'paper', 'purpur', 'spigot', 'bukkit', 'fabric', 'forge', 'neoforge',
    'vanilla', 'bungeecord', 'velocity', 'other'
  ));

-- Best-effort backfill from the only signal that has ever existed: the
-- template's own name. Order matters — 'neoforge' must be tested before
-- 'forge', and 'purpur' before 'paper', or a broader pattern swallows the
-- narrower one. ELSE NULL (not 'other'): NULL means "nobody has said,"
-- which the API/UI treat as "no addon guidance available" and an admin
-- can still fix from the Templates page; 'other' would be an assertion
-- that it is positively known NOT to be one of the listed kinds, which a
-- name-substring guess can't actually claim.
UPDATE "server_templates" SET "software_kind" = CASE
  WHEN "name" ILIKE '%neoforge%'                             THEN 'neoforge'
  WHEN "name" ILIKE '%purpur%'                               THEN 'purpur'
  WHEN "name" ILIKE '%paper%'                                THEN 'paper'
  WHEN "name" ILIKE '%spigot%'                               THEN 'spigot'
  WHEN "name" ILIKE '%bukkit%'                                THEN 'bukkit'
  WHEN "name" ILIKE '%fabric%'                               THEN 'fabric'
  WHEN "name" ILIKE '%forge%'                                THEN 'forge'
  WHEN "name" ILIKE '%velocity%'                             THEN 'velocity'
  WHEN "name" ILIKE '%bungee%' OR "name" ILIKE '%waterfall%' THEN 'bungeecord'
  WHEN "name" ILIKE '%vanilla%'                              THEN 'vanilla'
  ELSE NULL
END
WHERE "software_kind" IS NULL;
