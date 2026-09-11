-- Server.templateId/dockerImage/startupCommand become nullable: a server
-- born from the post-purchase provisioning flow reserves capacity (plan
-- slot + node RAM/disk/CPU/allocation/uid — CapacityService only ever
-- filters on `status <> 'deleting'`) BEFORE the customer has chosen a
-- software/version, so there is nothing yet to snapshot into these three
-- columns. Every existing row already has all three set and is never
-- 'setup_pending', so this migration needs no backfill.
ALTER TABLE "servers" ALTER COLUMN "template_id" DROP NOT NULL;
ALTER TABLE "servers" ALTER COLUMN "docker_image" DROP NOT NULL;
ALTER TABLE "servers" ALTER COLUMN "startup_command" DROP NOT NULL;

ALTER TABLE "servers" DROP CONSTRAINT "servers_status_check";
ALTER TABLE "servers" ADD CONSTRAINT "servers_status_check"
  CHECK ("status" IN ('setup_pending', 'installing', 'install_failed', 'ready',
                       'suspended', 'restoring_backup', 'transferring', 'deleting'));

-- Same posture as servers_suspension_consistency (and its own
-- suspension_source sibling right above it): status and the columns it
-- implies can never disagree. Biconditional on template_id specifically
-- so no reader of a non-'setup_pending' row can ever meet a NULL
-- template — the moment status leaves 'setup_pending' the other two
-- flip to NOT NULL together with it, in the same row.
ALTER TABLE "servers" ADD CONSTRAINT "servers_setup_consistency"
  CHECK (("status" = 'setup_pending') = ("template_id" IS NULL)
         AND ("status" = 'setup_pending'
              OR ("docker_image" IS NOT NULL AND "startup_command" IS NOT NULL)));
