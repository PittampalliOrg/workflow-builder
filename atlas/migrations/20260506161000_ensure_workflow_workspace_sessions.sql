CREATE TABLE IF NOT EXISTS "workflow_workspace_sessions" (
  "workspace_ref" text PRIMARY KEY,
  "workflow_execution_id" text NULL REFERENCES "workflow_executions" ("id") ON DELETE CASCADE,
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
  "sandbox_state" jsonb NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  "last_accessed_at" timestamp NOT NULL DEFAULT now(),
  "cleaned_at" timestamp NULL
);

ALTER TABLE "workflow_workspace_sessions"
  ALTER COLUMN "workflow_execution_id" DROP NOT NULL;

ALTER TABLE "workflow_workspace_sessions"
  ADD COLUMN IF NOT EXISTS "durable_instance_id" text NULL,
  ADD COLUMN IF NOT EXISTS "clone_path" text NULL,
  ADD COLUMN IF NOT EXISTS "require_read_before_write" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "command_timeout_ms" integer NOT NULL DEFAULT 30000,
  ADD COLUMN IF NOT EXISTS "last_error" text NULL,
  ADD COLUMN IF NOT EXISTS "sandbox_state" jsonb NULL,
  ADD COLUMN IF NOT EXISTS "last_accessed_at" timestamp NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "cleaned_at" timestamp NULL;

CREATE INDEX IF NOT EXISTS "idx_workflow_workspace_sessions_execution"
  ON "workflow_workspace_sessions" ("workflow_execution_id");

CREATE INDEX IF NOT EXISTS "idx_workflow_workspace_sessions_instance"
  ON "workflow_workspace_sessions" ("durable_instance_id");

CREATE INDEX IF NOT EXISTS "idx_workflow_workspace_sessions_status"
  ON "workflow_workspace_sessions" ("status");
