-- Customer testimonials for the public landing page. One row per user
-- (upserted on resubmission); the admin selects which approved rows are
-- `featured`, and in what order, for the public site.
CREATE TABLE "testimonials" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "user_id" UUID NOT NULL,
  "author_name" TEXT NOT NULL,
  "rating" SMALLINT NOT NULL,
  "message" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "featured" BOOLEAN NOT NULL DEFAULT false,
  "featured_order" INTEGER,
  "moderated_by" UUID,
  "moderated_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "testimonials_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "testimonials_user_id_key" ON "testimonials"("user_id");
CREATE INDEX "testimonials_status_created_at_idx" ON "testimonials"("status", "created_at");
CREATE INDEX "testimonials_featured_featured_order_idx" ON "testimonials"("featured", "featured_order");

ALTER TABLE "testimonials" ADD CONSTRAINT "testimonials_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "testimonials" ADD CONSTRAINT "testimonials_status_check" CHECK ("status" IN ('pending', 'approved', 'rejected'));

ALTER TABLE "testimonials" ADD CONSTRAINT "testimonials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Same tenant-ownership shape as support_tickets (0047): the owner sees/
-- writes only their own row, an admin context sees/writes every row. The
-- PUBLIC read of featured testimonials goes through the admin-bypass
-- context (`withRLS({ userId: null, isAdmin: true }, ...)`), same as every
-- other system-level read in this codebase — there is no "anonymous" RLS
-- branch here.
ALTER TABLE "testimonials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY testimonials_tenant ON "testimonials"
  USING (current_app_is_admin() OR "user_id" = current_app_user())
  WITH CHECK (current_app_is_admin() OR "user_id" = current_app_user());
