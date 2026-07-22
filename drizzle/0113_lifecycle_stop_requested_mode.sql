-- Persist the terminal stop mode beside the stop timestamp. The lifecycle
-- resolver writes both atomically with monotonic terminate < purge < reset
-- semantics; legacy rows with a timestamp and no mode begin as terminate.
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "stop_requested_mode" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stop_requested_mode" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "runtime_provisioning_started_at" timestamp;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "runtime_host_owned" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
UPDATE "sessions" AS child
SET "runtime_host_owned" = false
FROM "sessions" AS parent
WHERE child."parent_execution_id" = parent."id"
  AND child."runtime_app_id" IS NOT NULL
  AND child."runtime_app_id" = parent."runtime_app_id"
  AND child."runtime_sandbox_name" IS NOT DISTINCT FROM parent."runtime_sandbox_name";
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow_executions"
    ADD CONSTRAINT "workflow_executions_stop_requested_mode_check"
    CHECK ("stop_requested_mode" IS NULL OR "stop_requested_mode" IN ('terminate', 'purge', 'reset'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_stop_requested_mode_check"
    CHECK ("stop_requested_mode" IS NULL OR "stop_requested_mode" IN ('terminate', 'purge', 'reset'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
