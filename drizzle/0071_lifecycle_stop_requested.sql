-- Lifecycle stop-intent: decouple "termination requested" from "confirmed
-- terminal" so a slow-to-apply Dapr terminate no longer reports a false failure
-- and leaves the row stuck non-terminal. stopDurableRun stamps stop_requested_at
-- the moment a stop is requested; the cascade or the terminal-status reaper
-- finalizes (flips status) once the durable tree is confirmed closed.
-- Idempotent (ADD COLUMN IF NOT EXISTS) — the runtime migrator is self-healing
-- and the --custom snapshot does not record these columns.
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "stop_requested_at" timestamp;
--> statement-breakpoint
ALTER TABLE "workflow_executions" ADD COLUMN IF NOT EXISTS "stop_reason" text;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stop_requested_at" timestamp;
