-- Workflow-level helper hosts have no interactive session row. Persist their
-- exact provider identity before creation so terminal execution cleanup remains
-- crash-safe and independently retryable.
CREATE TABLE IF NOT EXISTS "workflow_execution_runtime_hosts" (
  "workflow_execution_id" text NOT NULL REFERENCES "workflow_executions"("id") ON DELETE RESTRICT,
  "purpose" text NOT NULL,
  "helper_session_id" text NOT NULL,
  "generation_started_at" timestamp NOT NULL,
  "runtime_app_id" text NOT NULL,
  "runtime_instance_id" text NOT NULL,
  "runtime_sandbox_name" text NOT NULL,
  "owned" boolean DEFAULT true NOT NULL,
  "operation_id" text,
  "operation_started_at" timestamp,
  "provisioned_at" timestamp,
  "cleanup_attempted_at" timestamp,
  "cleanup_completed_at" timestamp,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "workflow_execution_runtime_hosts_pkey"
    PRIMARY KEY ("workflow_execution_id", "purpose"),
  CONSTRAINT "workflow_execution_runtime_hosts_operation_consistent" CHECK (
    (
      "operation_id" IS NULL
      AND "operation_started_at" IS NULL
    ) OR (
      "operation_id" IS NOT NULL
      AND "operation_started_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_workflow_execution_runtime_hosts_runtime_app"
  ON "workflow_execution_runtime_hosts" ("runtime_app_id");

CREATE INDEX IF NOT EXISTS "idx_workflow_execution_runtime_hosts_cleanup"
  ON "workflow_execution_runtime_hosts" (
    "cleanup_completed_at",
    "cleanup_attempted_at",
    "operation_started_at"
  );

-- Legacy stable-id __cliws hosts are intentionally not backfilled because no
-- crash-safe generation identity exists for them. Their compute lifetime is
-- bounded by the route's finite 1-240 minute timeout. SEA's best-effort PVC
-- owner binding normally removes their storage too, but a pre-migration owner
-- binding failure remains legacy operational debt rather than guessed ownership.
-- Every post-migration call reserves an exact generation in this durable queue.
