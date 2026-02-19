CREATE TABLE "workflow_ai_tool_messages" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_id" text NOT NULL,
  "user_id" text NOT NULL,
  "message_id" text NOT NULL,
  "role" text NOT NULL,
  "parts" jsonb NOT NULL,
  "text_content" text DEFAULT '' NOT NULL,
  "mentions" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "uq_workflow_ai_tool_messages_workflow_user_message"
    UNIQUE("workflow_id","user_id","message_id")
);

ALTER TABLE "workflow_ai_tool_messages"
  ADD CONSTRAINT "workflow_ai_tool_messages_workflow_id_workflows_id_fk"
  FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id")
  ON DELETE cascade ON UPDATE no action;

ALTER TABLE "workflow_ai_tool_messages"
  ADD CONSTRAINT "workflow_ai_tool_messages_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")
  ON DELETE cascade ON UPDATE no action;

CREATE INDEX "idx_workflow_ai_tool_messages_workflow_user_created"
  ON "workflow_ai_tool_messages" USING btree ("workflow_id","user_id","created_at");
