CREATE TABLE "friendships" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "pair_key" TEXT NOT NULL,
  "requester_id" UUID NOT NULL,
  "addressee_id" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "accepted_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "friendships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "friendships_distinct_users" CHECK ("requester_id" <> "addressee_id"),
  CONSTRAINT "friendships_status" CHECK ("status" IN ('pending', 'accepted')),
  CONSTRAINT "friendships_acceptance" CHECK (("status" = 'accepted') = ("accepted_at" IS NOT NULL)),
  CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "friendships_pair_key_key" ON "friendships"("pair_key");
CREATE INDEX "friendships_requester_id_status_idx" ON "friendships"("requester_id", "status");
CREATE INDEX "friendships_addressee_id_status_idx" ON "friendships"("addressee_id", "status");

CREATE TABLE "community_servers" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "server_id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "address" TEXT NOT NULL,
  "software" TEXT,
  "version" TEXT,
  "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "community_servers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "community_servers_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE,
  CONSTRAINT "community_servers_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "community_servers_server_id_key" ON "community_servers"("server_id");
CREATE INDEX "community_servers_owner_id_idx" ON "community_servers"("owner_id");
CREATE INDEX "community_servers_published_at_idx" ON "community_servers"("published_at");

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "friendships" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "community_servers" TO app_user;
