-- UI-initiated sessions provision a per-session sandbox but don't live
-- inside a workflow_executions row. Drop the NOT NULL on
-- workflow_workspace_sessions.workflow_execution_id so the workspace-runtime
-- can persist rows for UI sessions without an FK target. The FK itself stays
-- — workflow-driven rows keep CASCADE cleanup semantics; UI rows have a
-- null FK and get reaped via the TTL/cleanup path.
ALTER TABLE workflow_workspace_sessions
  ALTER COLUMN workflow_execution_id DROP NOT NULL;
