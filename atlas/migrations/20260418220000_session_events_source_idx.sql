-- Phase 4 follow-up: idempotency for session event dual-writes.
--
-- When session_workflow spawns agent_workflow, agent events flow via two
-- paths that both attempt to write to session_events:
--   (1) Direct HTTP POST from event_publisher._post_ingest (for session.*
--       status events — publish_session_event path)
--   (2) The /api/internal/dapr/agent-stream subscription handler dual-writes
--       CMA-shaped agent events (agent.message, agent.tool_use,
--       agent.tool_result) when the NATS envelope carries a sessionId
--
-- On Dapr workflow replay, (1) and (2) can each fire the same event twice.
-- Add a partial unique index on (session_id, source_event_id) so the second
-- insert idempotently fails and appendEvent's retry loop swallows it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_session_events_source
  ON session_events (session_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
