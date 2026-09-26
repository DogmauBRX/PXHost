-- Keep both billing cycles of the public Básico plan on the same CPU
-- allocation. Node-level capacity remains configured per environment.
UPDATE "plans"
SET "cpu_limit_percent" = 300
WHERE "slug" IN ('basico', 'basico-trimestral')
  AND "deleted_at" IS NULL;
