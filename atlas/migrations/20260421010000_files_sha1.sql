-- Cross-turn dedup for session output artifacts. When a multi-turn agent
-- rewrites the same file (e.g., updates a report between turns), we only
-- want a new `files` row when content actually changed. Stash a sha1 of
-- the bytes at upload time; the ingest endpoint checks for a pre-existing
-- (scope_id, name, sha1) tuple and short-circuits identical re-uploads.
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS sha1 text;

CREATE INDEX IF NOT EXISTS idx_files_scope_name_sha1
  ON files (scope_id, name, sha1)
  WHERE scope_id IS NOT NULL AND sha1 IS NOT NULL;
