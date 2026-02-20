CREATE TABLE "runtime_config_audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"store_name" text NOT NULL,
	"config_key" text NOT NULL,
	"value" text NOT NULL,
	"metadata" jsonb,
	"status" text NOT NULL,
	"provider" text,
	"provider_response" jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_config_audit_logs" ADD CONSTRAINT "runtime_config_audit_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "runtime_config_audit_logs" ADD CONSTRAINT "runtime_config_audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_runtime_cfg_audit_project_created" ON "runtime_config_audit_logs" USING btree ("project_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_runtime_cfg_audit_project_key" ON "runtime_config_audit_logs" USING btree ("project_id","config_key");
