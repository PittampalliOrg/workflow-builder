-- Historical Atlas mirror of drizzle/0117_team_member_launch_recovery.sql.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_operation_id" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_kind" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_started_at" timestamp;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_completed_at" timestamp;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_cleanup_requested_at" timestamp;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_cleanup_action" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_previous_session_id" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_previous_status" text;

ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "launch_dispatch_recipe" jsonb;

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_launch_kind_check";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_launch_kind_check" CHECK (
    "launch_kind" IS NULL OR "launch_kind" IN ('spawn', 'revival')
  );

ALTER TABLE "team_members"
  DROP CONSTRAINT IF EXISTS "team_members_launch_metadata_consistent";

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_launch_metadata_consistent" CHECK (
    (
      "launch_operation_id" IS NULL
      AND "launch_kind" IS NULL
      AND "launch_started_at" IS NULL
      AND "launch_completed_at" IS NULL
      AND "launch_cleanup_requested_at" IS NULL
      AND "launch_cleanup_action" IS NULL
      AND "launch_previous_session_id" IS NULL
      AND "launch_previous_status" IS NULL
      AND "launch_dispatch_recipe" IS NULL
    )
    OR (
      "launch_operation_id" IS NOT NULL
      AND "launch_kind" IS NOT NULL
      AND "launch_started_at" IS NOT NULL
      AND "launch_dispatch_recipe" IS NOT NULL
      AND jsonb_typeof("launch_dispatch_recipe") = 'object'
      AND NOT (
        "launch_completed_at" IS NOT NULL
        AND "launch_cleanup_requested_at" IS NOT NULL
      )
      AND (
        (
          "launch_cleanup_requested_at" IS NULL
          AND "launch_cleanup_action" IS NULL
        )
        OR (
          "launch_cleanup_requested_at" IS NOT NULL
          AND "launch_cleanup_action" IS NOT NULL
          AND "launch_cleanup_action" IN ('purge', 'unwind')
        )
      )
      AND (
        (
          "launch_kind" = 'spawn'
          AND "launch_previous_session_id" IS NULL
          AND "launch_previous_status" IS NULL
        )
        OR (
          "launch_kind" = 'revival'
          AND "launch_previous_session_id" IS NOT NULL
          AND "launch_previous_status" IS NOT NULL
          AND "launch_previous_status" IN ('failed', 'shutdown')
        )
      )
    )
  );

CREATE INDEX IF NOT EXISTS "team_members_launch_reconcile_idx"
  ON "team_members" ("launch_started_at", "id")
  WHERE "status" = 'starting' AND "launch_operation_id" IS NOT NULL;
