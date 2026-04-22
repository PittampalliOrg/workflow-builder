-- Producer-Id triple (durable-streams shape) for universal event idempotency
-- and CMA-aligned provenance.
--
-- Columns: producer_id (agent slug — joins with agents.slug), producer_epoch
-- (pod process start-time in ns, as text to avoid bigint juggling in js).
--
-- Partial unique index enforces (session_id, source_event_id) dedup only
-- where source_event_id IS NOT NULL. Historical rows with NULL source_event_id
-- continue to coexist; new events emitted post-upgrade all carry a
-- triple-valued source_event_id via event_publisher._default_source_event_id,
-- so retries + stale-pod writes dedup automatically. The existing catch block
-- in src/lib/server/sessions/events.ts::appendEvent already expects this
-- constraint — this migration finally creates it.
--
-- Idempotent via IF NOT EXISTS.

ALTER TABLE session_events
  ADD COLUMN IF NOT EXISTS producer_id TEXT,
  ADD COLUMN IF NOT EXISTS producer_epoch TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_session_events_source
  ON session_events (session_id, source_event_id)
  WHERE source_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_session_events_producer
  ON session_events (producer_id, producer_epoch);
