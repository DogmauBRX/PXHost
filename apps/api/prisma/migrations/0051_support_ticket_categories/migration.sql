-- More specific, client-facing support categories. Priority is calculated by
-- the application from this category and is no longer accepted from clients.

ALTER TABLE "support_tickets" DROP CONSTRAINT "support_tickets_category_check";

UPDATE "support_tickets"
SET "category" = CASE "category"
  WHEN 'technical' THEN 'server_error'
  WHEN 'billing' THEN 'billing'
  WHEN 'account' THEN 'account_access'
  WHEN 'other' THEN 'general_question'
  ELSE 'general_question'
END;

UPDATE "support_tickets"
SET "priority" = CASE "category"
  WHEN 'server_offline' THEN 'urgent'
  WHEN 'server_error' THEN 'high'
  WHEN 'performance_mods' THEN 'normal'
  WHEN 'billing' THEN 'normal'
  WHEN 'account_access' THEN 'high'
  WHEN 'general_question' THEN 'low'
END;

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_check"
  CHECK ("category" IN ('server_offline', 'server_error', 'performance_mods', 'billing', 'account_access', 'general_question'));
