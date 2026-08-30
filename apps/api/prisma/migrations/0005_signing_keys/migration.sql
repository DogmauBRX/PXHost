-- Milestone M13: capability-token signing key rotation (architecture doc
-- 3.4). See schema.prisma's SigningKey model doc comment for the
-- current/retiring/retired state machine this table drives.

CREATE TABLE "signing_keys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "kid" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key_enc" BYTEA,
    "state" TEXT NOT NULL DEFAULT 'current',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promoted_at" TIMESTAMPTZ,
    "retired_at" TIMESTAMPTZ,

    CONSTRAINT "signing_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "signing_keys_kid_key" ON "signing_keys"("kid");

ALTER TABLE "signing_keys" ADD CONSTRAINT "signing_keys_state_check"
  CHECK ("state" IN ('current', 'retiring', 'retired'));

-- Not RLS-protected: signing keys are node/agent infrastructure, not
-- tenant data, same posture as nodes/allocations. Grants already cover
-- it via 0002_rls_policies's blanket ALTER DEFAULT PRIVILEGES.
