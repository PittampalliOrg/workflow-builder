ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "resumed_from_session_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_sessions_resumed_from" ON "sessions" ("resumed_from_session_id");
