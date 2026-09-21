CREATE TABLE "oauth_identities" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "email" CITEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "oauth_identities_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "oauth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "oauth_identities_provider_provider_subject_key"
  ON "oauth_identities"("provider", "provider_subject");
CREATE UNIQUE INDEX "oauth_identities_provider_user_id_key"
  ON "oauth_identities"("provider", "user_id");
CREATE INDEX "oauth_identities_user_id_idx" ON "oauth_identities"("user_id");

-- OAuth identities are authentication infrastructure, never tenant-facing
-- data. The API resolves them before it has an authenticated user context.
-- It is therefore intentionally not protected by the tenant RLS policies.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "oauth_identities" TO app_user;
