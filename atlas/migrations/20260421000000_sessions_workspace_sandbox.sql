-- UI sessions now provision a per-session OpenShell sandbox via
-- openshell-agent-runtime's /api/workspaces/profile, same pattern workflow
-- `durable/run` nodes use. The sandbox name lands here so session_workflow
-- can pass it to agent_workflow, which configures the runtime before
-- bash/file tools fire.
--
-- Separate from `sessions.sandbox_name` (added in Step 2b) which tags the
-- runtime app (`dapr-agent-py`) for the sandbox-detail list filters. This
-- column is the per-session sandbox (format `ws-<uuid>`).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS workspace_sandbox_name text;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_sandbox
  ON sessions (workspace_sandbox_name)
  WHERE workspace_sandbox_name IS NOT NULL;
