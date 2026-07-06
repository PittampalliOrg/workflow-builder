-- Session needs-input cache (CLI-agent lifecycle reliability — deferred item 3).
-- pending_input is a rebuildable cache of "this session is waiting on a human"
-- maintained by the single serialized ingest writer: SET when a session blocks
-- (permission prompt / question / tool-confirmation request), CLEARed when it
-- resumes, terminates, errors, or the user answers. Session events remain the
-- source of truth; this column lets the session LIST + Fleet surfaces badge a
-- parked session without scanning session_events. Additive + nullable — no
-- backfill (a blocked session re-emits its blocked idle; existing rows stay
-- NULL until the next relevant event).
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "pending_input" jsonb;
