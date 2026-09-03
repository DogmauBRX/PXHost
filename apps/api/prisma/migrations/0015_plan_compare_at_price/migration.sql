-- Commercial site — an optional anchor "de" price for the public plan
-- card (see Plan.compareAtPriceCents's own doc comment in schema.prisma
-- for why this is a plain admin-set field, not a coupon/campaign
-- system). NULL means "no anchor price" — every existing plan reads
-- this way, zero behavior change on deploy.
ALTER TABLE "plans" ADD COLUMN "compare_at_price_cents" INTEGER;

-- A "de" price that isn't actually higher than the real price is
-- meaningless (a 0% or negative "discount"), and would render as a
-- broken-looking badge — the DB refuses that shape outright rather
-- than relying on every future write path to remember the rule.
ALTER TABLE "plans" ADD CONSTRAINT "plans_compare_at_price_check"
  CHECK ("compare_at_price_cents" IS NULL OR "compare_at_price_cents" > "price_cents");
