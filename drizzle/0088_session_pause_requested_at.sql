-- Lifecycle pause/resume (docs/long-running-session-durability-plan.md follow-up).
-- A session is "paused" via Dapr suspend_workflow (state SUSPENDED — alive,
-- non-terminal, resumable), distinct from Stop (terminate/purge). This column
-- records the pause-intent: set on pause, cleared on resume. Lifecycle
-- reconciliation paths must treat rows with it set as suspended, not terminal
-- cleanup candidates. Additive + nullable — no backfill, no behavior change
-- for existing rows.
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pause_requested_at" timestamp;
