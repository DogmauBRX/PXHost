-- Billing profile, collected at checkout time (SubscriptionsService
-- .createForUser), never at signup — see the User model's own doc
-- comment. All nullable: most rows have none until their owner actually
-- subscribes to something.
ALTER TABLE "users" ADD COLUMN "cpf" VARCHAR(11);
ALTER TABLE "users" ADD COLUMN "billing_postal_code" VARCHAR(8);
ALTER TABLE "users" ADD COLUMN "billing_address_line" TEXT;
ALTER TABLE "users" ADD COLUMN "billing_address_number" TEXT;
ALTER TABLE "users" ADD COLUMN "billing_address_complement" TEXT;
ALTER TABLE "users" ADD COLUMN "billing_neighborhood" TEXT;
ALTER TABLE "users" ADD COLUMN "billing_city" TEXT;
ALTER TABLE "users" ADD COLUMN "billing_state" VARCHAR(2);
ALTER TABLE "users" ADD COLUMN "billing_country" VARCHAR(2) DEFAULT 'BR';

-- Same soft-delete-aware partial uniqueness as email/username
-- (migrations/0001_init/migration.sql's "Partial unique indexes"
-- section) — a real tax ID must be unique per active account, but a
-- soft-deleted row must never block someone else from using the same
-- CPF, and most rows have no CPF at all (NULL is already distinct from
-- NULL under a plain unique index, but excluding NULLs outright keeps
-- the index smaller).
CREATE UNIQUE INDEX "users_cpf_uq" ON "users" ("cpf") WHERE "deleted_at" IS NULL AND "cpf" IS NOT NULL;
