-- In-panel customer support. Tickets are tenant-owned and messages inherit
-- that ownership through their parent ticket. Staff access uses the same
-- current_app_is_admin() context as every other admin surface.

CREATE TABLE "support_tickets" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "user_id" UUID NOT NULL,
  "server_id" UUID,
  "subject" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "priority" TEXT NOT NULL DEFAULT 'normal',
  "status" TEXT NOT NULL DEFAULT 'open',
  "last_message_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "support_ticket_messages" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "ticket_id" UUID NOT NULL,
  "author_id" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "is_staff" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "support_ticket_messages_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_category_check"
  CHECK ("category" IN ('technical', 'billing', 'account', 'other'));
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_priority_check"
  CHECK ("priority" IN ('low', 'normal', 'high', 'urgent'));
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_status_check"
  CHECK ("status" IN ('open', 'in_progress', 'waiting_customer', 'closed'));

ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_server_id_fkey"
  FOREIGN KEY ("server_id") REFERENCES "servers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "support_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "support_ticket_messages" ADD CONSTRAINT "support_ticket_messages_author_id_fkey"
  FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "support_tickets_user_id_last_message_at_idx" ON "support_tickets"("user_id", "last_message_at" DESC);
CREATE INDEX "support_tickets_status_priority_last_message_at_idx" ON "support_tickets"("status", "priority", "last_message_at" DESC);
CREATE INDEX "support_ticket_messages_ticket_id_created_at_idx" ON "support_ticket_messages"("ticket_id", "created_at");

ALTER TABLE "support_tickets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_tickets_tenant ON "support_tickets"
  USING (current_app_is_admin() OR "user_id" = current_app_user())
  WITH CHECK (current_app_is_admin() OR "user_id" = current_app_user());

ALTER TABLE "support_ticket_messages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY support_ticket_messages_tenant ON "support_ticket_messages"
  USING (
    current_app_is_admin()
    OR EXISTS (
      SELECT 1 FROM "support_tickets" t
      WHERE t."id" = "support_ticket_messages"."ticket_id"
        AND t."user_id" = current_app_user()
    )
  )
  WITH CHECK (
    current_app_is_admin()
    OR EXISTS (
      SELECT 1 FROM "support_tickets" t
      WHERE t."id" = "support_ticket_messages"."ticket_id"
        AND t."user_id" = current_app_user()
    )
  );
