CREATE TABLE IF NOT EXISTS "workflow_plan_artifacts" (
	"id" text PRIMARY KEY,
	"workflow_execution_id" text NOT NULL REFERENCES "workflow_executions" ("id") ON DELETE CASCADE,
	"workflow_id" text NOT NULL REFERENCES "workflows" ("id") ON DELETE CASCADE,
	"user_id" text NULL REFERENCES "users" ("id") ON DELETE SET NULL,
	"node_id" text NOT NULL,
	"workspace_ref" text NULL,
	"clone_path" text NULL,
	"artifact_type" text NOT NULL DEFAULT 'claude_task_graph_v1',
	"artifact_version" integer NOT NULL DEFAULT 1,
	"status" text NOT NULL DEFAULT 'draft',
	"goal" text NOT NULL,
	"plan_json" jsonb NOT NULL,
	"plan_markdown" text NULL,
	"source_prompt" text NULL,
	"metadata" jsonb NULL,
	"created_at" timestamp NOT NULL DEFAULT now(),
	"updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_plan_artifacts_execution_created"
	ON "workflow_plan_artifacts" ("workflow_execution_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_plan_artifacts_workflow_node_created"
	ON "workflow_plan_artifacts" ("workflow_id", "node_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_plan_artifacts_status"
	ON "workflow_plan_artifacts" ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_plan_artifacts_user_created"
	ON "workflow_plan_artifacts" ("user_id", "created_at");
