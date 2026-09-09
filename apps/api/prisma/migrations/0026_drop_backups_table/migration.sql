-- Drops the "backups" table: dead-on-arrival schema, scaffolded in the
-- initial commit but never wired to any read/write logic anywhere in
-- src/ (confirmed via grep for prisma.backup.*/tx.backup.*, zero hits).
-- Backup metadata has always lived entirely on the agent side
-- (AgentClient.listBackups/createBackup/deleteBackup/restoreBackup) — this
-- table's own FKs, RLS policy, unique "one running per server" index, and
-- check constraints all drop along with it, no CASCADE needed since
-- nothing else references "backups" by foreign key.
DROP TABLE "backups";
