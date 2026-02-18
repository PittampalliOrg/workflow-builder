-- Durable plan artifacts for plan->execute workflow handoff
CREATE TABLE "workflow_plan_artifacts" (
  "id" text NOT NULL,
  "workflow_execution_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "user_id" text NULL,
  "node_id" text NOT NULL,
  "workspace_ref" text NULL,
  "clone_path" text NULL,
  "artifact_type" text NOT NULL DEFAULT 'task_graph_v1',
  "artifact_version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'draft',
  "goal" text NOT NULL,
  "plan_json" jsonb NOT NULL,
  "plan_markdown" text NULL,
  "source_prompt" text NULL,
  "metadata" jsonb NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "workflow_plan_artifacts_execution_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "workflow_plan_artifacts_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "workflow_plan_artifacts_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE SET NULL
);

CREATE INDEX "idx_workflow_plan_artifacts_execution_created" ON "workflow_plan_artifacts" ("workflow_execution_id", "created_at");
CREATE INDEX "idx_workflow_plan_artifacts_workflow_node_created" ON "workflow_plan_artifacts" ("workflow_id", "node_id", "created_at");
CREATE INDEX "idx_workflow_plan_artifacts_status" ON "workflow_plan_artifacts" ("status");
CREATE INDEX "idx_workflow_plan_artifacts_user_created" ON "workflow_plan_artifacts" ("user_id", "created_at");

-- Durable workspace session metadata for restart-safe mapping recovery
CREATE TABLE "workflow_workspace_sessions" (
  "workspace_ref" text NOT NULL,
  "workflow_execution_id" text NOT NULL,
  "durable_instance_id" text NULL,
  "name" text NOT NULL,
  "root_path" text NOT NULL,
  "clone_path" text NULL,
  "backend" text NOT NULL,
  "enabled_tools" jsonb NOT NULL,
  "require_read_before_write" boolean NOT NULL DEFAULT false,
  "command_timeout_ms" integer NOT NULL DEFAULT 30000,
  "status" text NOT NULL DEFAULT 'active',
  "last_error" text NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "last_accessed_at" timestamp NOT NULL DEFAULT now(),
  "cleaned_at" timestamp NULL,
  PRIMARY KEY ("workspace_ref"),
  CONSTRAINT "workflow_workspace_sessions_execution_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE
);

CREATE INDEX "idx_workflow_workspace_sessions_execution" ON "workflow_workspace_sessions" ("workflow_execution_id");
CREATE INDEX "idx_workflow_workspace_sessions_instance" ON "workflow_workspace_sessions" ("durable_instance_id");
CREATE INDEX "idx_workflow_workspace_sessions_status" ON "workflow_workspace_sessions" ("status");

-- Durable child run tracking for completion replay/reconciliation
CREATE TABLE "workflow_agent_runs" (
  "id" text NOT NULL,
  "workflow_execution_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "node_id" text NOT NULL,
  "mode" text NOT NULL,
  "agent_workflow_id" text NOT NULL,
  "dapr_instance_id" text NOT NULL,
  "parent_execution_id" text NOT NULL,
  "workspace_ref" text NULL,
  "artifact_ref" text NULL,
  "status" text NOT NULL DEFAULT 'scheduled',
  "result" jsonb NULL,
  "error" text NULL,
  "completed_at" timestamp NULL,
  "event_published_at" timestamp NULL,
  "last_reconciled_at" timestamp NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("id"),
  CONSTRAINT "workflow_agent_runs_execution_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "workflow_executions" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "workflow_agent_runs_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "workflows" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "uq_workflow_agent_runs_instance" UNIQUE ("dapr_instance_id"),
  CONSTRAINT "uq_workflow_agent_runs_agent_workflow" UNIQUE ("agent_workflow_id")
);

CREATE INDEX "idx_workflow_agent_runs_execution" ON "workflow_agent_runs" ("workflow_execution_id", "created_at");
CREATE INDEX "idx_workflow_agent_runs_status" ON "workflow_agent_runs" ("status", "event_published_at");
