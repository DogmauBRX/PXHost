-- Keep the payment gateway on the subscription itself. Orders already
-- record it, but recurring charges/cancellation/reconciliation operate
-- from a Subscription after the original Order is no longer in scope.
ALTER TABLE "subscriptions"
  ADD COLUMN "payment_provider" TEXT NOT NULL DEFAULT 'mercadopago';

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_payment_provider_check"
  CHECK ("payment_provider" IN ('mercadopago', 'pagbank'));

CREATE INDEX "subscriptions_payment_provider_idx"
  ON "subscriptions"("payment_provider");
