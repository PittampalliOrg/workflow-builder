-- Phase 4 Step 2b: tag each session with the agent runtime Dapr app that
-- ran it, so the sandbox detail UI (/api/sandboxes/[name]/executions +
-- /api/sandboxes/[name]/stream) can filter sessions by runtime. Replaces
-- `workflow_agent_events.sandbox_name` which went away when we deleted the
-- legacy workflow.stream subscription in the same commit.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS sandbox_name text;

CREATE INDEX IF NOT EXISTS idx_sessions_sandbox_name
  ON sessions (sandbox_name)
  WHERE sandbox_name IS NOT NULL;

-- Backfill existing rows with the current default runtime so the UI keeps
-- showing historical sessions when filtering by `dapr-agent-py`.
UPDATE sessions
  SET sandbox_name = 'dapr-agent-py'
  WHERE sandbox_name IS NULL;
