-- A terminal session's owned per-session runtime host must be deleted before
-- cleanup is acknowledged. NULL is the durable retry obligation; a timestamp
-- proves SEA confirmed the host deleted or already absent.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "runtime_host_cleanup_completed_at" timestamp;

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "runtime_host_cleanup_attempted_at" timestamp;

CREATE INDEX IF NOT EXISTS "idx_sessions_runtime_host_cleanup"
  ON "sessions" (
    "runtime_host_cleanup_completed_at",
    "runtime_host_cleanup_attempted_at",
    "completed_at"
  );
