-- Quilt is a first-class mod-loader option. Recreate the existing check
-- constraint because PostgreSQL CHECK constraints cannot be extended in place.
ALTER TABLE "server_templates"
  DROP CONSTRAINT "server_templates_software_kind_check";

ALTER TABLE "server_templates"
  ADD CONSTRAINT "server_templates_software_kind_check"
  CHECK ("software_kind" IS NULL OR "software_kind" IN (
    'paper', 'purpur', 'spigot', 'bukkit', 'fabric', 'quilt', 'forge', 'neoforge',
    'vanilla', 'bungeecord', 'velocity', 'other'
  ));
