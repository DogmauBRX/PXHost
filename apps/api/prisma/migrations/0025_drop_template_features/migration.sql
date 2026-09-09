-- Drops ServerTemplate.features: dead Pterodactyl-inherited data, written
-- once by prisma/seed.ts and read nowhere in src/ (confirmed via grep).
ALTER TABLE "server_templates" DROP COLUMN "features";
