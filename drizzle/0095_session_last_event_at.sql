-- Session liveness stamp (W2 — CLI-agent lifecycle reliability).
-- last_event_at records the last time ANY session event was ingested. The
-- ingest path bumps it at most once per 5s window and NEVER touches
-- updated_at, so it stays a pure liveness marker: the session liveness
-- reconciler reads it to tell a quiet-but-alive session from a dead/orphaned
-- one without scanning session_events. Additive + nullable — no behavior
-- change for existing rows.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "last_event_at" timestamp;
--> statement-breakpoint
-- Backfill ONLY non-completed rows (completed sessions never feed the liveness
-- reconciler, so their marker can stay NULL). A CORRELATED subquery per session
-- uses the session_events(session_id) index and only touches rows that actually
-- have events — vs a whole-table GROUP BY aggregate over session_events.
UPDATE "sessions" AS s
SET "last_event_at" = (
	SELECT MAX(e."created_at")
	FROM "session_events" AS e
	WHERE e."session_id" = s."id"
)
WHERE s."completed_at" IS NULL
	AND s."last_event_at" IS NULL
	AND EXISTS (
		SELECT 1 FROM "session_events" AS e2 WHERE e2."session_id" = s."id"
	);
