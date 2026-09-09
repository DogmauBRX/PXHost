-- Template visibility to customers, ahead of the Mercado Pago checkout
-- work (payments plan §1). `is_active` already existed on
-- server_templates but was written by the admin form and read by
-- nobody — this migration is also the first thing that makes it real.
--
-- `is_public` defaults to false on purpose: no administrative template
-- becomes customer-facing by accident. An admin opts each template in
-- explicitly. Existing templates (Paper/Fabric/Vanilla from the seed)
-- stay admin-only until someone flips the toggle.
ALTER TABLE "server_templates" ADD COLUMN "is_public"  boolean NOT NULL DEFAULT false;
ALTER TABLE "server_templates" ADD COLUMN "sort_order" integer NOT NULL DEFAULT 0;
ALTER TABLE "server_templates" ADD COLUMN "icon_url"   text;

-- Partial index matching the exact filter the public catalog query uses
-- (is_public = true, deleted_at IS NULL, ordered by sort_order).
CREATE INDEX "server_templates_public_idx" ON "server_templates" ("is_public", "sort_order") WHERE "deleted_at" IS NULL;
