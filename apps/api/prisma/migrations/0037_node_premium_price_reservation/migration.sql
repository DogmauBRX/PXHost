-- Placement policy: reserve a node for plans priced at or above a given
-- amount (cents), so a pricier plan added LATER automatically prefers
-- that node with no per-plan configuration. NULL = no reservation,
-- every existing node's behavior is unchanged.
ALTER TABLE "nodes" ADD COLUMN "reserved_for_plans_above_price_cents" INTEGER;
