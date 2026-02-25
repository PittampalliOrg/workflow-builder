-- Add sandbox_state column to persist K8s sandbox pod metadata for reconnection
ALTER TABLE "workflow_workspace_sessions" ADD COLUMN IF NOT EXISTS "sandbox_state" jsonb NULL;
