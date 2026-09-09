-- A future heads-up for planned maintenance, distinct from
-- `maintenance_mode` itself ("in maintenance right now"). Nullable,
-- purely informational — see the column's own doc comment in
-- schema.prisma. NULL for every existing node, zero behavior change.
ALTER TABLE "nodes" ADD COLUMN "maintenance_scheduled_at" TIMESTAMPTZ;
