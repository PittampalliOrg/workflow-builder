-- Per-agent sandbox runtime: every published agent maps to a dedicated
-- Kubernetes pod (agent-runtime-<slug>) with its own Dapr app-id. Track
-- the app-id on the agent row + the mirror of AgentRuntime.status.phase
-- for fast UI reads.
--
-- runtime_app_id is a derived identifier (agent-runtime-<slug>) we stamp at
-- publish time so the workflow-orchestrator can route ctx.call_child_workflow
-- without an extra BFF roundtrip. Stays null for archived or never-published
-- rows.
--
-- runtime_status mirrors the controller's AgentRuntime.status.phase so the
-- agent detail page renders Sleeping / Starting / Active / Failed without a
-- live K8s API hit. Updated by a lightweight reconcile poll.
--
-- Idempotent via IF NOT EXISTS. Backfill runs in the companion Bun script
-- scripts/create-agent-runtime-crs.ts which also materializes the CRs.

BEGIN;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runtime_app_id TEXT;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runtime_status TEXT NOT NULL DEFAULT 'pending';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runtime_status_synced_at TIMESTAMP WITH TIME ZONE;

-- Best-effort backfill for rows that already have a slug. Never overrides a
-- value someone already set, since we use WHERE NULL.
UPDATE agents
   SET runtime_app_id = 'agent-runtime-' || slug
 WHERE runtime_app_id IS NULL
   AND NOT is_archived;

CREATE INDEX IF NOT EXISTS idx_agents_runtime_app_id
  ON agents(runtime_app_id)
  WHERE runtime_app_id IS NOT NULL;

COMMIT;
