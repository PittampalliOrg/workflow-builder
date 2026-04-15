CREATE TABLE "workflow_code_checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_execution_id" text NOT NULL,
	"workflow_agent_run_id" text,
	"workflow_agent_event_id" integer,
	"parent_execution_id" text,
	"dapr_instance_id" text NOT NULL,
	"workspace_ref" text,
	"sandbox_name" text,
	"repo_path" text NOT NULL,
	"node_id" text,
	"source_event_id" text NOT NULL,
	"seq" integer,
	"tool_name" text NOT NULL,
	"checkpoint_kind" text DEFAULT 'tool_mutation' NOT NULL,
	"before_sha" text,
	"after_sha" text,
	"changed_files" jsonb NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_workflow_code_checkpoints_event" UNIQUE("workflow_execution_id","dapr_instance_id","source_event_id","checkpoint_kind")
);

ALTER TABLE "workflow_code_checkpoints"
ADD CONSTRAINT "workflow_code_checkpoints_workflow_execution_id_workflow_executions_id_fk"
FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions"("id")
ON DELETE cascade ON UPDATE no action;

ALTER TABLE "workflow_code_checkpoints"
ADD CONSTRAINT "workflow_code_checkpoints_workflow_agent_run_id_workflow_agent_runs_id_fk"
FOREIGN KEY ("workflow_agent_run_id") REFERENCES "workflow_agent_runs"("id")
ON DELETE set null ON UPDATE no action;

ALTER TABLE "workflow_code_checkpoints"
ADD CONSTRAINT "workflow_code_checkpoints_workflow_agent_event_id_workflow_agent_events_event_id_fk"
FOREIGN KEY ("workflow_agent_event_id") REFERENCES "workflow_agent_events"("event_id")
ON DELETE set null ON UPDATE no action;

CREATE INDEX "idx_workflow_code_checkpoints_execution_seq"
ON "workflow_code_checkpoints" ("workflow_execution_id","seq");

CREATE INDEX "idx_workflow_code_checkpoints_agent_run_seq"
ON "workflow_code_checkpoints" ("workflow_agent_run_id","seq");

CREATE INDEX "idx_workflow_code_checkpoints_workspace_created"
ON "workflow_code_checkpoints" ("workspace_ref","created_at");

CREATE INDEX "idx_workflow_code_checkpoints_after_sha"
ON "workflow_code_checkpoints" ("after_sha");
