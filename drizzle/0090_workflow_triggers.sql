-- Event-driven workflow triggers (docs/event-driven-workflow-triggers.md).
-- Additive + idempotent (hand-authored to match the 0089 style; drizzle-kit
-- generate needs a TTY for its conflict prompt).
--
--   workflow_executions.trigger_source: set when a run was started by the
--     event-driven trigger spine (to the firing trigger's id). NULL for
--     manual/API runs. Drives the triggered-run concurrency gate + capacity lens.
--   workflow_triggers: one row per configured trigger on a workflow; status
--     tracks the activation/reconcile lifecycle.

ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "trigger_source" text;
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_trigger_source_status"
  ON "workflow_executions" ("trigger_source", "status");

CREATE TABLE IF NOT EXISTS "workflow_triggers" (
  "id" text PRIMARY KEY NOT NULL,
  "workflow_id" text NOT NULL,
  "user_id" text NOT NULL,
  "project_id" text,
  "kind" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "trigger_data" jsonb,
  "dedup_salt" text NOT NULL,
  "backing_ref" text,
  "status" text DEFAULT 'inactive' NOT NULL,
  "last_error" text,
  "last_fired_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_workflow_triggers_workflow_status"
  ON "workflow_triggers" ("workflow_id", "status");
CREATE INDEX IF NOT EXISTS "idx_workflow_triggers_kind"
  ON "workflow_triggers" ("kind");

DO $$ BEGIN
  ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_id_workflows_id_fk"
    FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN
  ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null; END $$;
