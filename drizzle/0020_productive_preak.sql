CREATE TABLE "workflow_agent_events" (
	"event_id" serial PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"workflow_agent_run_id" text,
	"parent_execution_id" text,
	"dapr_instance_id" text NOT NULL,
	"source_event_id" text NOT NULL,
	"seq" integer,
	"event_type" text NOT NULL,
	"phase" text,
	"tool_name" text,
	"sandbox_name" text,
	"trace_id" text,
	"payload" jsonb NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workflow_agent_events_source" UNIQUE("workflow_execution_id","dapr_instance_id","source_event_id")
);
--> statement-breakpoint
ALTER TABLE "workflow_agent_events" ADD CONSTRAINT "workflow_agent_events_workflow_execution_id_workflow_executions_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_agent_events" ADD CONSTRAINT "workflow_agent_events_workflow_agent_run_id_workflow_agent_runs_id_fk" FOREIGN KEY ("workflow_agent_run_id") REFERENCES "public"."workflow_agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workflow_agent_events_execution_seq" ON "workflow_agent_events" USING btree ("workflow_execution_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_agent_events_agent_run_seq" ON "workflow_agent_events" USING btree ("workflow_agent_run_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_agent_events_instance_seq" ON "workflow_agent_events" USING btree ("dapr_instance_id","event_id");