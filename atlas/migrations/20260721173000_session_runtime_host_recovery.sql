-- Historical Atlas mirror of drizzle/0115_session_runtime_host_recovery.sql.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "runtime_host_launch_spec" jsonb;
