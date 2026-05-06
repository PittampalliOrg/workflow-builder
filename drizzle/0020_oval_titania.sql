CREATE TABLE IF NOT EXISTS "workflow_agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"mode" text NOT NULL,
	"agent_workflow_id" text NOT NULL,
	"dapr_instance_id" text NOT NULL,
	"parent_execution_id" text NOT NULL,
	"workspace_ref" text,
	"artifact_ref" text,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"result" jsonb,
	"error" text,
	"completed_at" timestamp,
	"event_published_at" timestamp,
	"last_reconciled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_agent_runs_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "workflow_agent_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workflow_agent_runs_instance" ON "workflow_agent_runs" USING btree ("dapr_instance_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_workflow_agent_runs_agent_workflow" ON "workflow_agent_runs" USING btree ("agent_workflow_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_agent_runs_execution" ON "workflow_agent_runs" USING btree ("workflow_execution_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_agent_runs_status" ON "workflow_agent_runs" USING btree ("status","event_published_at");
--> statement-breakpoint
CREATE TABLE "workflow_agent_events" (
	"event_id" serial PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"workflow_agent_run_id" text,
	"parent_execution_id" text,
	"dapr_instance_id" text NOT NULL,
	"seq" integer,
	"event_type" text NOT NULL,
	"phase" text,
	"tool_name" text,
	"sandbox_name" text,
	"trace_id" text,
	"payload" jsonb NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_agent_events" ADD CONSTRAINT "workflow_agent_events_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_agent_events" ADD CONSTRAINT "workflow_agent_events_workflow_agent_run_id_workflow_agent_runs_id_fk" FOREIGN KEY ("workflow_agent_run_id") REFERENCES "public"."workflow_agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_agent_events_execution_seq" ON "workflow_agent_events" USING btree ("workflow_execution_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_agent_events_instance_seq" ON "workflow_agent_events" USING btree ("dapr_instance_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_agent_events_agent_run_seq" ON "workflow_agent_events" USING btree ("workflow_agent_run_id","event_id");
