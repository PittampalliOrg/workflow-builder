-- Serialize teammate host delivery and suspend operations in Postgres. The
-- operation token fences external runtime-host work while desired_running is
-- the durable intent consulted before a raise or scale transition.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "runtime_operation_id" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "runtime_operation" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "runtime_operation_started_at" timestamp;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "runtime_desired_running" boolean DEFAULT true NOT NULL;

-- A suspended teammate already has durable stopped intent. Preserve it during
-- the upgrade instead of making the first post-upgrade delivery/suspend race
-- treat the runtime as desired-running.
UPDATE "team_members"
SET "runtime_desired_running" = false
WHERE "status" = 'suspended';

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_runtime_operation_consistent";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_runtime_operation_consistent" CHECK (
    (
      "runtime_operation_id" IS NULL
      AND "runtime_operation" IS NULL
      AND "runtime_operation_started_at" IS NULL
    )
    OR (
      "runtime_operation_id" IS NOT NULL
      AND "runtime_operation_started_at" IS NOT NULL
      AND (
        ("runtime_operation" = 'delivery' AND "runtime_desired_running" = true)
        OR ("runtime_operation" = 'suspend' AND "runtime_desired_running" = false)
      )
    )
  );
