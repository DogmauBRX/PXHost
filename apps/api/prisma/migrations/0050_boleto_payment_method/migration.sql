-- Boleto is a manual payment method just like Pix: every billing cycle
-- gets a new charge and only the provider webhook confirms settlement.
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_payment_method_check";
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_payment_method_check"
  CHECK ("payment_method" IN ('pix', 'boleto', 'card') OR "payment_method" IS NULL);

ALTER TABLE "orders" ADD COLUMN "boleto_digitable_line" TEXT;
ALTER TABLE "orders" ADD COLUMN "boleto_url" TEXT;
