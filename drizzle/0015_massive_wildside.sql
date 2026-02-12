CREATE TABLE "workflow_ai_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"operations" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_ai_messages" ADD CONSTRAINT "workflow_ai_messages_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_ai_messages" ADD CONSTRAINT "workflow_ai_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_ai_messages_workflow_created" ON "workflow_ai_messages" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_ai_messages_user_created" ON "workflow_ai_messages" USING btree ("user_id","created_at");