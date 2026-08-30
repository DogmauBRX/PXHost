-- Extensions and the uuidv7() shim (architecture doc 2.2/2.7 note 12):
-- native on PostgreSQL 18, so on 17 this is a SQL-level shim over
-- gen_random_uuid() — same schema either way, swapped in a one-line
-- migration on upgrade to 18 for the real time-ordered implementation.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'uuidv7') THEN
    CREATE FUNCTION uuidv7() RETURNS uuid LANGUAGE sql AS $uuidv7$
      SELECT gen_random_uuid()
    $uuidv7$;
  END IF;
END $$;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" CITEXT NOT NULL,
    "username" CITEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "language" TEXT NOT NULL DEFAULT 'pt-BR',
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "global_role" TEXT NOT NULL DEFAULT 'user',
    "admin_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "totp_secret_enc" BYTEA,
    "totp_enabled_at" TIMESTAMPTZ,
    "recovery_codes_enc" BYTEA,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "email_verified_at" TIMESTAMPTZ,
    "last_login_at" TIMESTAMPTZ,
    "failed_logins" SMALLINT NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "tokens_valid_after" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "refresh_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL DEFAULT uuidv7(),
    "parent_id" UUID,
    "user_agent" TEXT,
    "ip" INET,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "key_type" TEXT NOT NULL DEFAULT 'account',
    "identifier" CHAR(16) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "memo" TEXT NOT NULL DEFAULT '',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_ips" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_catalog" (
    "key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "i18n_key" TEXT NOT NULL,
    "is_dangerous" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "permission_catalog_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "locations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "short_code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" CHAR(2),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nodes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "location_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fqdn" TEXT NOT NULL,
    "scheme" TEXT NOT NULL DEFAULT 'https',
    "daemon_port" INTEGER NOT NULL DEFAULT 8443,
    "sftp_port" INTEGER NOT NULL DEFAULT 2022,
    "daemon_data_path" TEXT NOT NULL DEFAULT '/var/lib/pxhost/volumes',
    "behind_proxy" BOOLEAN NOT NULL DEFAULT false,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "maintenance_mode" BOOLEAN NOT NULL DEFAULT false,
    "memory_total_mb" INTEGER NOT NULL,
    "memory_reserved_mb" INTEGER NOT NULL DEFAULT 0,
    "memory_overallocate_pct" INTEGER NOT NULL DEFAULT 0,
    "disk_total_mb" INTEGER NOT NULL,
    "disk_reserved_mb" INTEGER NOT NULL DEFAULT 0,
    "disk_overallocate_pct" INTEGER NOT NULL DEFAULT 0,
    "cpu_total_percent" INTEGER NOT NULL DEFAULT 0,
    "cpu_overallocate_pct" INTEGER NOT NULL DEFAULT -1,
    "upload_size_mb" INTEGER NOT NULL DEFAULT 256,
    "health_status" TEXT NOT NULL DEFAULT 'unknown',
    "last_heartbeat_at" TIMESTAMPTZ,
    "agent_version" TEXT,
    "docker_version" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "node_id" UUID NOT NULL,
    "token_id" CHAR(16) NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "last_used_at" TIMESTAMPTZ,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "node_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocations" (
    "id" BIGSERIAL NOT NULL,
    "node_id" UUID NOT NULL,
    "ip" INET NOT NULL,
    "ip_alias" TEXT,
    "port" INTEGER NOT NULL,
    "server_id" UUID,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mounts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source_path" TEXT NOT NULL,
    "target_path" TEXT NOT NULL,
    "is_read_only" BOOLEAN NOT NULL DEFAULT true,
    "user_mountable" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mount_nodes" (
    "mount_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,

    CONSTRAINT "mount_nodes_pkey" PRIMARY KEY ("mount_id","node_id")
);

-- CreateTable
CREATE TABLE "mount_templates" (
    "mount_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,

    CONSTRAINT "mount_templates_pkey" PRIMARY KEY ("mount_id","template_id")
);

-- CreateTable
CREATE TABLE "server_mounts" (
    "server_id" UUID NOT NULL,
    "mount_id" UUID NOT NULL,

    CONSTRAINT "server_mounts_pkey" PRIMARY KEY ("server_id","mount_id")
);

-- CreateTable
CREATE TABLE "template_groups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "template_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_templates" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "group_id" UUID NOT NULL,
    "parent_id" UUID,
    "name" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "description" TEXT,
    "docker_images" JSONB NOT NULL,
    "startup_command" TEXT NOT NULL,
    "stop_command" TEXT NOT NULL DEFAULT 'stop',
    "config_files" JSONB NOT NULL DEFAULT '{}',
    "config_startup" JSONB NOT NULL DEFAULT '{}',
    "config_logs" JSONB NOT NULL DEFAULT '{}',
    "install_image" TEXT NOT NULL DEFAULT 'ghcr.io/pxhost/installers:debian',
    "install_entrypoint" TEXT NOT NULL DEFAULT 'bash',
    "install_script" TEXT NOT NULL,
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "force_outgoing_ip" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "server_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_variables" (
    "id" BIGSERIAL NOT NULL,
    "template_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "env_variable" TEXT NOT NULL,
    "default_value" TEXT NOT NULL DEFAULT '',
    "rules" TEXT NOT NULL DEFAULT 'nullable|string',
    "is_user_viewable" BOOLEAN NOT NULL DEFAULT true,
    "is_user_editable" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "template_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "is_public" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "cpu_limit_percent" INTEGER NOT NULL DEFAULT 100,
    "cpu_pinning" TEXT NOT NULL DEFAULT '',
    "memory_mb" INTEGER NOT NULL,
    "swap_mb" INTEGER NOT NULL DEFAULT 0,
    "disk_mb" INTEGER NOT NULL,
    "io_weight" INTEGER NOT NULL DEFAULT 500,
    "block_io_read_bps" BIGINT NOT NULL DEFAULT 0,
    "block_io_write_bps" BIGINT NOT NULL DEFAULT 0,
    "oom_kill_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_databases" INTEGER NOT NULL DEFAULT 0,
    "max_backups" INTEGER NOT NULL DEFAULT 0,
    "max_allocations" INTEGER NOT NULL DEFAULT 1,
    "max_schedules" INTEGER NOT NULL DEFAULT 5,
    "backup_retention_days" INTEGER NOT NULL DEFAULT 7,
    "allowed_group_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "price_cents" INTEGER NOT NULL DEFAULT 0,
    "currency" CHAR(3) NOT NULL DEFAULT 'BRL',
    "billing_period" TEXT NOT NULL DEFAULT 'monthly',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "servers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "short_id" CHAR(8) NOT NULL,
    "owner_id" UUID NOT NULL,
    "node_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "plan_id" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "docker_image" TEXT NOT NULL,
    "startup_command" TEXT NOT NULL,
    "cpu_limit_percent" INTEGER NOT NULL DEFAULT 100,
    "cpu_pinning" TEXT NOT NULL DEFAULT '',
    "memory_mb" INTEGER NOT NULL,
    "swap_mb" INTEGER NOT NULL DEFAULT 0,
    "disk_mb" INTEGER NOT NULL,
    "io_weight" INTEGER NOT NULL DEFAULT 500,
    "block_io_read_bps" BIGINT NOT NULL DEFAULT 0,
    "block_io_write_bps" BIGINT NOT NULL DEFAULT 0,
    "oom_kill_enabled" BOOLEAN NOT NULL DEFAULT false,
    "max_databases" INTEGER NOT NULL DEFAULT 0,
    "max_backups" INTEGER NOT NULL DEFAULT 0,
    "max_allocations" INTEGER NOT NULL DEFAULT 1,
    "max_schedules" INTEGER NOT NULL DEFAULT 5,
    "status" TEXT NOT NULL DEFAULT 'installing',
    "suspended_at" TIMESTAMPTZ,
    "suspension_reason" TEXT,
    "power_state" TEXT NOT NULL DEFAULT 'offline',
    "power_state_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_disk_used_mb" INTEGER NOT NULL DEFAULT 0,
    "installed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "servers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_variables" (
    "id" BIGSERIAL NOT NULL,
    "server_id" UUID NOT NULL,
    "variable_id" BIGINT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "server_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subusers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "server_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "invited_by" UUID,
    "accepted_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subusers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "server_id" UUID NOT NULL,
    "created_by" UUID,
    "name" TEXT NOT NULL,
    "adapter" TEXT NOT NULL DEFAULT 'local',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "ignored_globs" TEXT NOT NULL DEFAULT '',
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "checksum" TEXT,
    "checksum_algo" TEXT NOT NULL DEFAULT 'sha256',
    "is_locked" BOOLEAN NOT NULL DEFAULT false,
    "upload_id" TEXT,
    "error_message" TEXT,
    "completed_at" TIMESTAMPTZ,
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "backups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "database_hosts" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 3306,
    "username" TEXT NOT NULL,
    "password_enc" BYTEA NOT NULL,
    "key_version" SMALLINT NOT NULL DEFAULT 1,
    "node_id" UUID,
    "max_databases" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "database_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "databases" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "server_id" UUID NOT NULL,
    "host_id" UUID NOT NULL,
    "database" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_enc" BYTEA NOT NULL,
    "key_version" SMALLINT NOT NULL DEFAULT 1,
    "remote" TEXT NOT NULL DEFAULT '%',
    "max_connections" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "databases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "server_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "cron_minute" TEXT NOT NULL DEFAULT '*',
    "cron_hour" TEXT NOT NULL DEFAULT '*',
    "cron_day_of_month" TEXT NOT NULL DEFAULT '*',
    "cron_month" TEXT NOT NULL DEFAULT '*',
    "cron_day_of_week" TEXT NOT NULL DEFAULT '*',
    "timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "only_when_online" BOOLEAN NOT NULL DEFAULT false,
    "is_processing" BOOLEAN NOT NULL DEFAULT false,
    "last_run_at" TIMESTAMPTZ,
    "last_run_status" TEXT,
    "next_run_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "schedule_id" UUID NOT NULL,
    "sequence_number" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '',
    "time_offset_seconds" INTEGER NOT NULL DEFAULT 0,
    "continue_on_failure" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_transfers" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "server_id" UUID NOT NULL,
    "source_node_id" UUID NOT NULL,
    "target_node_id" UUID NOT NULL,
    "target_allocation_id" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_logs" (
    "id" BIGSERIAL NOT NULL,
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'user',
    "server_id" UUID,
    "event" TEXT NOT NULL,
    "ip" INET,
    "properties" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "actor_email" TEXT,
    "actor_ip" INET,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_metrics_1m" (
    "server_id" UUID NOT NULL,
    "bucket" TIMESTAMPTZ NOT NULL,
    "cpu_percent" DOUBLE PRECISION NOT NULL,
    "memory_bytes" BIGINT NOT NULL,
    "disk_bytes" BIGINT NOT NULL,
    "net_rx_bytes" BIGINT NOT NULL,
    "net_tx_bytes" BIGINT NOT NULL,

    CONSTRAINT "server_metrics_1m_pkey" PRIMARY KEY ("server_id","bucket")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_identifier_key" ON "api_keys"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "node_tokens_token_id_key" ON "node_tokens"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "allocations_node_id_ip_port_key" ON "allocations"("node_id", "ip", "port");

-- CreateIndex
CREATE UNIQUE INDEX "template_variables_template_id_env_variable_key" ON "template_variables"("template_id", "env_variable");

-- CreateIndex
CREATE UNIQUE INDEX "servers_short_id_key" ON "servers"("short_id");

-- CreateIndex
CREATE UNIQUE INDEX "server_variables_server_id_variable_id_key" ON "server_variables"("server_id", "variable_id");

-- CreateIndex
CREATE UNIQUE INDEX "subusers_server_id_user_id_key" ON "subusers"("server_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "databases_host_id_database_key" ON "databases"("host_id", "database");

-- CreateIndex
CREATE UNIQUE INDEX "databases_host_id_username_key" ON "databases"("host_id", "username");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_schedule_id_sequence_number_key" ON "tasks"("schedule_id", "sequence_number");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_tokens" ADD CONSTRAINT "node_tokens_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_tokens" ADD CONSTRAINT "node_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mount_nodes" ADD CONSTRAINT "mount_nodes_mount_id_fkey" FOREIGN KEY ("mount_id") REFERENCES "mounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mount_nodes" ADD CONSTRAINT "mount_nodes_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mount_templates" ADD CONSTRAINT "mount_templates_mount_id_fkey" FOREIGN KEY ("mount_id") REFERENCES "mounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mount_templates" ADD CONSTRAINT "mount_templates_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "server_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_mounts" ADD CONSTRAINT "server_mounts_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_mounts" ADD CONSTRAINT "server_mounts_mount_id_fkey" FOREIGN KEY ("mount_id") REFERENCES "mounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_templates" ADD CONSTRAINT "server_templates_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "template_groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_templates" ADD CONSTRAINT "server_templates_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "server_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template_variables" ADD CONSTRAINT "template_variables_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "server_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "server_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "servers" ADD CONSTRAINT "servers_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_variables" ADD CONSTRAINT "server_variables_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_variables" ADD CONSTRAINT "server_variables_variable_id_fkey" FOREIGN KEY ("variable_id") REFERENCES "template_variables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subusers" ADD CONSTRAINT "subusers_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subusers" ADD CONSTRAINT "subusers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subusers" ADD CONSTRAINT "subusers_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backups" ADD CONSTRAINT "backups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "database_hosts" ADD CONSTRAINT "database_hosts_node_id_fkey" FOREIGN KEY ("node_id") REFERENCES "nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "databases" ADD CONSTRAINT "databases_host_id_fkey" FOREIGN KEY ("host_id") REFERENCES "database_hosts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_transfers" ADD CONSTRAINT "server_transfers_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_transfers" ADD CONSTRAINT "server_transfers_source_node_id_fkey" FOREIGN KEY ("source_node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_transfers" ADD CONSTRAINT "server_transfers_target_node_id_fkey" FOREIGN KEY ("target_node_id") REFERENCES "nodes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "server_metrics_1m" ADD CONSTRAINT "server_metrics_1m_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─────────────────────────────────────────────────────────────────
-- Status CHECK constraints (architecture doc 2.1: text + CHECK, not
-- native ENUM, so values map 1:1 to TS string unions and are migratable
-- transactionally). Added by hand: Prisma's schema DSL has no CHECK
-- constraint syntax.
-- ─────────────────────────────────────────────────────────────────

ALTER TABLE "users" ADD CONSTRAINT "users_global_role_check"
  CHECK ("global_role" IN ('root_admin','admin','support','user'));

ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_key_type_check"
  CHECK ("key_type" IN ('account','application'));

ALTER TABLE "permission_catalog" ADD CONSTRAINT "permission_catalog_scope_check"
  CHECK ("scope" IN ('server','admin'));

ALTER TABLE "nodes" ADD CONSTRAINT "nodes_health_status_check"
  CHECK ("health_status" IN ('unknown','online','degraded','offline'));

ALTER TABLE "nodes" ADD CONSTRAINT "nodes_scheme_check"
  CHECK ("scheme" IN ('http','https'));

ALTER TABLE "node_tokens" ADD CONSTRAINT "node_tokens_status_check"
  CHECK ("status" IN ('pending','active','revoked'));

ALTER TABLE "plans" ADD CONSTRAINT "plans_billing_period_check"
  CHECK ("billing_period" IN ('monthly','quarterly','annual','none'));

ALTER TABLE "servers" ADD CONSTRAINT "servers_status_check"
  CHECK ("status" IN ('installing','install_failed','ready','suspended','restoring_backup','transferring','deleting'));

ALTER TABLE "servers" ADD CONSTRAINT "servers_power_state_check"
  CHECK ("power_state" IN ('offline','starting','running','stopping','crashed'));

ALTER TABLE "servers" ADD CONSTRAINT "servers_suspension_consistency"
  CHECK (("status" = 'suspended') = ("suspended_at" IS NOT NULL));

ALTER TABLE "backups" ADD CONSTRAINT "backups_adapter_check"
  CHECK ("adapter" IN ('local','s3'));

ALTER TABLE "backups" ADD CONSTRAINT "backups_status_check"
  CHECK ("status" IN ('pending','running','success','failed','deleting'));

ALTER TABLE "schedules" ADD CONSTRAINT "schedules_last_run_status_check"
  CHECK ("last_run_status" IS NULL OR "last_run_status" IN ('success','failed','skipped'));

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_action_check"
  CHECK ("action" IN ('command','power','backup','delete_files'));

ALTER TABLE "server_transfers" ADD CONSTRAINT "server_transfers_status_check"
  CHECK ("status" IN ('pending','archiving','uploading','restoring','success','failed','cancelled'));

ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_type_check"
  CHECK ("actor_type" IN ('user','system','schedule','api_key','node'));

-- ─────────────────────────────────────────────────────────────────
-- Partial unique indexes (soft-delete-aware uniqueness) and single-row
-- guards. Prisma's @@unique has no WHERE clause, so these are hand-written.
-- ─────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "users_email_uq" ON "users" ("email") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "users_username_uq" ON "users" ("username") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "locations_code_uq" ON "locations" ("short_code") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "nodes_fqdn_uq" ON "nodes" (lower("fqdn")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "template_groups_name_uq" ON "template_groups" (lower("name")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "templates_group_name_uq" ON "server_templates" ("group_id", lower("name")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "plans_slug_uq" ON "plans" ("slug") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "db_hosts_addr_uq" ON "database_hosts" ("host", "port") WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "mounts_name_uq" ON "mounts" (lower("name"));

CREATE UNIQUE INDEX "allocations_one_primary_uq" ON "allocations" ("server_id") WHERE "is_primary";
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_primary_needs_server"
  CHECK (NOT "is_primary" OR "server_id" IS NOT NULL);

CREATE UNIQUE INDEX "backups_one_running" ON "backups" ("server_id") WHERE "status" IN ('pending','running');
CREATE UNIQUE INDEX "node_tokens_one_active" ON "node_tokens" ("node_id") WHERE "status" = 'active';
CREATE UNIQUE INDEX "transfers_one_active" ON "server_transfers" ("server_id")
  WHERE "status" NOT IN ('success','failed','cancelled');

-- ─────────────────────────────────────────────────────────────────
-- Owner cannot also be a subuser of their own server (architecture doc 2.1).
-- ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION assert_subuser_not_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "servers" s WHERE s."id" = NEW."server_id" AND s."owner_id" = NEW."user_id")
  THEN RAISE EXCEPTION 'owner cannot be a subuser'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER subusers_not_owner BEFORE INSERT OR UPDATE ON "subusers"
  FOR EACH ROW EXECUTE FUNCTION assert_subuser_not_owner();

-- ─────────────────────────────────────────────────────────────────
-- Helpful indexes for the hottest access paths (architecture doc 2.2/2.6).
-- ─────────────────────────────────────────────────────────────────

CREATE INDEX "servers_owner_idx" ON "servers" ("owner_id");
CREATE INDEX "servers_node_idx" ON "servers" ("node_id");
CREATE INDEX "servers_status_idx" ON "servers" ("status") WHERE "status" <> 'ready';
CREATE INDEX "allocations_free_idx" ON "allocations" ("node_id") WHERE "server_id" IS NULL;
CREATE INDEX "allocations_server_idx" ON "allocations" ("server_id");
CREATE INDEX "subusers_user_idx" ON "subusers" ("user_id");
CREATE INDEX "subusers_perms_gin" ON "subusers" USING gin ("permissions");
CREATE INDEX "backups_server_idx" ON "backups" ("server_id", "created_at" DESC) WHERE "deleted_at" IS NULL;
CREATE INDEX "schedules_due_idx" ON "schedules" ("next_run_at") WHERE "is_active" AND NOT "is_processing";
CREATE INDEX "activity_server_idx" ON "activity_logs" ("server_id", "id" DESC);
CREATE INDEX "activity_actor_idx" ON "activity_logs" ("actor_id", "id" DESC);
CREATE INDEX "audit_action_idx" ON "audit_logs" ("action", "occurred_at" DESC);
CREATE INDEX "audit_actor_idx" ON "audit_logs" ("actor_id", "occurred_at" DESC);
CREATE INDEX "nodes_deploy_idx" ON "nodes" ("location_id")
  WHERE "deleted_at" IS NULL AND "is_public" AND NOT "maintenance_mode";
