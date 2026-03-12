ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "error_stack_trace" text;

ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "rerun_of_execution_id" text;

ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "rerun_source_instance_id" text;

ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "rerun_from_event_id" integer;

DO $$
BEGIN
  ALTER TABLE "workflow_executions"
    ADD CONSTRAINT "workflow_executions_rerun_of_execution_id_workflow_executions_id_fk"
    FOREIGN KEY ("rerun_of_execution_id")
    REFERENCES "public"."workflow_executions"("id")
    ON DELETE set null
    ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
