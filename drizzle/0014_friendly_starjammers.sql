CREATE TABLE IF NOT EXISTS "mcp_run" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"mcp_server_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_execution_id" text,
	"dapr_instance_id" text,
	"tool_name" text NOT NULL,
	"input" jsonb NOT NULL,
	"response" jsonb,
	"status" text NOT NULL,
	"responded_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mcp_server" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"status" text DEFAULT 'DISABLED' NOT NULL,
	"token_encrypted" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_mcp_server_project_id" UNIQUE("project_id")
);
--> statement-breakpoint
ALTER TABLE IF EXISTS "oauth_app" RENAME TO "platform_oauth_apps";--> statement-breakpoint
DROP INDEX IF EXISTS "idx_oauth_app_piece_name";--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN IF NOT EXISTS "project_id" text;--> statement-breakpoint
INSERT INTO "platforms" ("id", "name", "owner_id", "created_at", "updated_at")
SELECT 'default_platform', 'Default Platform', NULL, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM "platforms");--> statement-breakpoint
DO $$
BEGIN
	IF to_regclass('public.platform_oauth_apps') IS NOT NULL THEN
		ALTER TABLE "platform_oauth_apps" ADD COLUMN IF NOT EXISTS "platform_id" text;
		UPDATE "platform_oauth_apps"
		SET "platform_id" = (SELECT "id" FROM "platforms" LIMIT 1)
		WHERE "platform_id" IS NULL;
		ALTER TABLE "platform_oauth_apps" ALTER COLUMN "platform_id" SET NOT NULL;
		ALTER TABLE "platform_oauth_apps" DROP COLUMN IF EXISTS "extra_params";
		BEGIN
			ALTER TABLE "platform_oauth_apps" ADD CONSTRAINT "platform_oauth_apps_platform_id_platforms_id_fk"
				FOREIGN KEY ("platform_id") REFERENCES "public"."platforms"("id") ON DELETE cascade ON UPDATE no action;
		EXCEPTION
			WHEN duplicate_object OR duplicate_table THEN NULL;
		END;
		BEGIN
			ALTER TABLE "platform_oauth_apps" ADD CONSTRAINT "uq_platform_oauth_apps_platform_piece"
				UNIQUE("platform_id","piece_name");
		EXCEPTION
			WHEN duplicate_object OR duplicate_table THEN NULL;
		END;
	END IF;
END $$;--> statement-breakpoint
DO $$
BEGIN
	BEGIN
		ALTER TABLE "mcp_run" ADD CONSTRAINT "mcp_run_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	EXCEPTION
		WHEN duplicate_object THEN NULL;
	END;
	BEGIN
		ALTER TABLE "mcp_run" ADD CONSTRAINT "mcp_run_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;
	EXCEPTION
		WHEN duplicate_object THEN NULL;
	END;
	BEGIN
		ALTER TABLE "mcp_run" ADD CONSTRAINT "mcp_run_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
	EXCEPTION
		WHEN duplicate_object THEN NULL;
	END;
	BEGIN
		ALTER TABLE "mcp_run" ADD CONSTRAINT "mcp_run_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE set null ON UPDATE no action;
	EXCEPTION
		WHEN duplicate_object THEN NULL;
	END;
	BEGIN
		ALTER TABLE "mcp_server" ADD CONSTRAINT "mcp_server_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	EXCEPTION
		WHEN duplicate_object THEN NULL;
	END;
	BEGIN
		ALTER TABLE "workflows" ADD CONSTRAINT "workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	EXCEPTION
		WHEN duplicate_object THEN NULL;
	END;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_run_project_id" ON "mcp_run" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_run_mcp_server_id" ON "mcp_run" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_run_workflow_id" ON "mcp_run" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_run_workflow_execution_id" ON "mcp_run" USING btree ("workflow_execution_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_mcp_server_project_id" ON "mcp_server" USING btree ("project_id");
