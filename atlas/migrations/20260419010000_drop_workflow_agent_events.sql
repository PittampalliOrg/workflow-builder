-- Phase 4 Step 2b: workflow_agent_events is retired. session_events is now
-- the authoritative agent activity log — every `durable/run` node spawns a
-- session_workflow that posts CMA-shape events straight to the BFF's ingest
-- endpoint. The legacy `workflow.stream` Dapr pub/sub producer + subscriber
-- were deleted in the same commit.
--
-- Drop order:
--   1. workflow_code_checkpoints.workflow_agent_event_id — FK to the dying
--      table. Column dropped (cascades remove the FK constraint).
--   2. workflow_executions.last_agent_event_id — denormalized pagination
--      cursor into workflow_agent_events; replaced by session_events.sequence
--      on the fly in the read-model.
--   3. workflow_agent_events table itself.
ALTER TABLE workflow_code_checkpoints
  DROP COLUMN IF EXISTS workflow_agent_event_id;

ALTER TABLE workflow_executions
  DROP COLUMN IF EXISTS last_agent_event_id;

DROP TABLE IF EXISTS workflow_agent_events;
