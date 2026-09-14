-- ghcr.io/pterodactyl/installers:debian (0034's fix) is real and public,
-- but lacks `jq` — every preset's install script parses a JSON version
-- manifest with it, so every install failed with "jq: command not
-- found" (exit 127/126). ghcr.io/parkervcp/installers:debian is the
-- actual, complete installer image the wider Pterodactyl egg ecosystem
-- builds against (curl, jq, unzip, tar all present) — confirmed by
-- running the real Vanilla install script against it end to end.
ALTER TABLE "server_templates" ALTER COLUMN "install_image" SET DEFAULT 'ghcr.io/parkervcp/installers:debian';
