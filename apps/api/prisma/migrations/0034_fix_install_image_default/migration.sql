-- The ghcr.io/pxhost/* images this column defaulted to were never
-- actually published (confirmed 404 on the registry) — every template
-- using this default failed to install with PULL_FAILED. Points at the
-- real, public Pterodactyl yolks/installers images instead.
ALTER TABLE "server_templates" ALTER COLUMN "install_image" SET DEFAULT 'ghcr.io/pterodactyl/installers:debian';
