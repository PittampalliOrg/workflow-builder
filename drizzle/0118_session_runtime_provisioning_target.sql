-- Preserve the exact unpublished runtime dispatch target under its lease.
-- Shared-pool app ids cannot be reconstructed from the session id, so these
-- fields make accepted crash-window durable instances lifecycle-addressable.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "runtime_provisioning_app_id" text,
  ADD COLUMN IF NOT EXISTS "runtime_provisioning_instance_id" text,
  ADD COLUMN IF NOT EXISTS "runtime_provisioning_sandbox_name" text,
  ADD COLUMN IF NOT EXISTS "runtime_provisioning_host_owned" boolean,
  ADD COLUMN IF NOT EXISTS "runtime_provisioning_host_launch_spec" jsonb;

ALTER TABLE "sessions"
  DROP CONSTRAINT IF EXISTS "sessions_runtime_provisioning_target_consistent";

ALTER TABLE "sessions"
  ADD CONSTRAINT "sessions_runtime_provisioning_target_consistent" CHECK (
    (
      "runtime_provisioning_app_id" IS NULL
      AND "runtime_provisioning_instance_id" IS NULL
      AND "runtime_provisioning_sandbox_name" IS NULL
      AND "runtime_provisioning_host_owned" IS NULL
      AND "runtime_provisioning_host_launch_spec" IS NULL
    )
    OR (
      "runtime_provisioning_started_at" IS NOT NULL
      AND "runtime_provisioning_app_id" IS NOT NULL
      AND "runtime_provisioning_instance_id" IS NOT NULL
      AND "runtime_provisioning_host_owned" IS NOT NULL
    )
  );
