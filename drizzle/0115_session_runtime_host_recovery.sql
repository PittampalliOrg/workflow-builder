-- Persist only the non-secret provider recipe required to recreate an exact
-- already-published runtime generation after its provisional host disappears.
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "runtime_host_launch_spec" jsonb;
