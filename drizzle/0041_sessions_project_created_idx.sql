-- Sessions list perf: composite (project_id, created_at DESC) index.
--
-- The workspace sessions page filters by project_id + archived_at IS NULL
-- and ORDER BY created_at DESC LIMIT 100. Without this index, Postgres
-- seq-scans sessions then sorts — fine at 100s of rows, slow at 10k+.
-- WHERE archived_at IS NULL makes the index partial so we only pay for
-- live rows. Idempotent via IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_sessions_project_created
	ON sessions (project_id, created_at DESC)
	WHERE archived_at IS NULL;
