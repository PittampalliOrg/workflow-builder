-- Dual-write to Dapr agent registry: track sync status per agent row.
--
-- registry_status tracks the mirror state; registry_synced_at is set on
-- every successful register/deregister; registry_error captures the last
-- failure so the UI can surface it. All three are derivative — Postgres
-- remains the source of truth and publishes never block on registry writes.
--
-- Idempotent via IF NOT EXISTS. Default 'unregistered' for all existing
-- rows; Phase 3 backfill script promotes them to 'registered'.

BEGIN;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS registry_status TEXT NOT NULL DEFAULT 'unregistered';

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS registry_synced_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS registry_error TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_registry_status
  ON agents(registry_status)
  WHERE registry_status IN ('failed', 'unregistered');

COMMIT;
