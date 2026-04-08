ALTER TABLE "workflow_executions"
ADD COLUMN "current_node_id" text,
ADD COLUMN "current_node_name" text,
ADD COLUMN "primary_trace_id" text,
ADD COLUMN "workflow_session_id" text,
ADD COLUMN "summary_output" jsonb,
ADD COLUMN "last_agent_event_id" integer;

UPDATE "workflow_executions"
SET "workflow_session_id" = "id"
WHERE "workflow_session_id" IS NULL;

CREATE INDEX "idx_workflow_executions_workflow_started"
ON "workflow_executions" ("workflow_id", "started_at");

CREATE INDEX "idx_workflow_executions_status_started"
ON "workflow_executions" ("status", "started_at");

CREATE INDEX "idx_workflow_executions_dapr_instance"
ON "workflow_executions" ("dapr_instance_id");

CREATE INDEX "idx_workflow_executions_session"
ON "workflow_executions" ("workflow_session_id");

CREATE INDEX "idx_workflow_execution_logs_execution_started"
ON "workflow_execution_logs" ("execution_id", "started_at");

CREATE INDEX "idx_workflow_execution_logs_execution_node"
ON "workflow_execution_logs" ("execution_id", "node_id");
