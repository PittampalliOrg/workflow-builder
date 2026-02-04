CREATE TABLE "function_executions" (
	"id" text PRIMARY KEY NOT NULL,
	"function_id" text,
	"workflow_execution_id" text,
	"node_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"error" text,
	"job_name" text,
	"pod_name" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"duration_ms" integer,
	"attempt_number" integer DEFAULT 1,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "functions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"plugin_id" text NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"execution_type" text DEFAULT 'builtin' NOT NULL,
	"image_ref" text,
	"command" text,
	"working_dir" text,
	"container_env" jsonb,
	"webhook_url" text,
	"webhook_method" text DEFAULT 'POST',
	"webhook_headers" jsonb,
	"webhook_timeout_seconds" integer DEFAULT 30,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"timeout_seconds" integer DEFAULT 300,
	"retry_policy" jsonb,
	"max_concurrency" integer DEFAULT 0,
	"integration_type" text,
	"is_builtin" boolean DEFAULT false,
	"is_enabled" boolean DEFAULT true,
	"is_deprecated" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "functions_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "function_executions" ADD CONSTRAINT "function_executions_function_id_functions_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."functions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "function_executions" ADD CONSTRAINT "function_executions_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "functions" ADD CONSTRAINT "functions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;