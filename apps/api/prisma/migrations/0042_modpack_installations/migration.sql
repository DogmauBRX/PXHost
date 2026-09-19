CREATE TABLE "modpack_installations" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "server_id" UUID NOT NULL,
  "requested_by" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "project_id" TEXT NOT NULL,
  "version_id" TEXT NOT NULL,
  "project_name" TEXT NOT NULL,
  "version_name" TEXT NOT NULL,
  "minecraft_version" TEXT NOT NULL,
  "loader" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "message" TEXT,
  "backup_id" TEXT,
  "error_message" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ,
  CONSTRAINT "modpack_installations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "modpack_installations_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE
);

CREATE INDEX "modpack_installations_server_id_created_at_idx" ON "modpack_installations"("server_id", "created_at");
ALTER TABLE "modpack_installations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "modpack_installations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "modpack_installations_tenant" ON "modpack_installations"
  USING (can_access_server("server_id")) WITH CHECK (can_access_server("server_id"));
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "modpack_installations" TO app_user;
