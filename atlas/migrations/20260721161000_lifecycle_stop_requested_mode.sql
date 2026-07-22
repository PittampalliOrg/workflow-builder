-- Historical Atlas mirror of drizzle/0113_lifecycle_stop_requested_mode.sql.
-- Drizzle remains the runtime schema owner; keep this migration complete for
-- operators that validate the historical Atlas migration directory.
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "stop_requested_mode" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stop_requested_mode" text;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "runtime_provisioning_started_at" timestamp;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "runtime_host_owned" boolean NOT NULL DEFAULT true;

UPDATE "sessions" AS child
SET "runtime_host_owned" = false
FROM "sessions" AS parent
WHERE child."parent_execution_id" = parent."id"
  AND child."runtime_app_id" IS NOT NULL
  AND child."runtime_app_id" = parent."runtime_app_id"
  AND child."runtime_sandbox_name" IS NOT DISTINCT FROM parent."runtime_sandbox_name";

DO $$ BEGIN
  ALTER TABLE "workflow_executions"
    ADD CONSTRAINT "workflow_executions_stop_requested_mode_check"
    CHECK ("stop_requested_mode" IS NULL OR "stop_requested_mode" IN ('terminate', 'purge', 'reset'));
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "sessions"
    ADD CONSTRAINT "sessions_stop_requested_mode_check"
    CHECK ("stop_requested_mode" IS NULL OR "stop_requested_mode" IN ('terminate', 'purge', 'reset'));
EXCEPTION WHEN duplicate_object THEN null; END $$;
