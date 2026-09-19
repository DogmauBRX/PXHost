-- Fabric/Forge/NeoForge's install scripts run `java -jar *-installer.jar
-- ...` themselves (unlike Paper/Purpur/Vanilla, which only ever `curl` a
-- prebuilt jar) — found live: every real Forge install failed with
-- "install script exited 127" (command not found) because
-- ghcr.io/parkervcp/installers:debian (0035's fix, for jq) has curl/jq/bash
-- but genuinely no JVM. ghcr.io/parkervcp/installers:java_25 is the same
-- image family with an OpenJDK added — confirmed present (`which java`)
-- and functional (`java -version`) on the real image.
--
-- Only the 3 templates whose install script actually invokes `java`
-- during install — Paper/Purpur/Vanilla stay on the lighter debian image,
-- they never needed a JVM until the runtime container starts.
UPDATE "server_templates"
SET "install_image" = 'ghcr.io/parkervcp/installers:java_25'
WHERE "software_kind" IN ('fabric', 'forge', 'neoforge')
  AND "install_image" = 'ghcr.io/parkervcp/installers:debian';
