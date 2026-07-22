-- Keep mailbox claim ownership separate from processed_at. A delivery worker
-- may crash after Dapr durably accepts the external event but before the BFF
-- records that acceptance, so claims must be stale-reclaimable and fenced by
-- an exact token while processed_at remains the raised/accepted marker.
ALTER TABLE "session_events"
  ADD COLUMN IF NOT EXISTS "team_delivery_claim_token" text;

ALTER TABLE "session_events"
  ADD COLUMN IF NOT EXISTS "team_delivery_claimed_at" timestamp;

CREATE INDEX IF NOT EXISTS "idx_session_events_team_delivery_claim"
  ON "session_events" ("session_id", "team_delivery_claimed_at")
  WHERE "processed_at" IS NULL
    AND "type" = 'user.message';
