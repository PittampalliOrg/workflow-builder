CREATE TABLE "workflow_browser_artifact_blob_payloads" (
	"storage_ref" text PRIMARY KEY NOT NULL,
	"payload_text" text NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_browser_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"workspace_ref" text,
	"artifact_type" text DEFAULT 'capture_flow_v1' NOT NULL,
	"artifact_version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"manifest_json" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_browser_artifacts" ADD CONSTRAINT "workflow_browser_artifacts_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_browser_artifacts" ADD CONSTRAINT "workflow_browser_artifacts_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_browser_artifacts_execution_created" ON "workflow_browser_artifacts" USING btree ("workflow_execution_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_browser_artifacts_workflow_node_created" ON "workflow_browser_artifacts" USING btree ("workflow_id","node_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_workflow_browser_artifacts_status" ON "workflow_browser_artifacts" USING btree ("status");