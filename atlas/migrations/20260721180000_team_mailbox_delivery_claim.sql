-- Historical Atlas mirror of drizzle/0116_team_mailbox_delivery_claim.sql.
ALTER TABLE "session_events"
  ADD COLUMN IF NOT EXISTS "team_delivery_claim_token" text;

ALTER TABLE "session_events"
  ADD COLUMN IF NOT EXISTS "team_delivery_claimed_at" timestamp;

CREATE INDEX IF NOT EXISTS "idx_session_events_team_delivery_claim"
  ON "session_events" ("session_id", "team_delivery_claimed_at")
  WHERE "processed_at" IS NULL
    AND "type" = 'user.message';
