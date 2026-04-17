-- CMA Files API: standalone uploaded files + agent-written output artifacts.
-- `files` carries metadata; `file_payloads` carries bytes in a sibling table
-- so metadata queries don't drag the TOAST blob along.
--
-- purpose:
--   'agent'  — uploaded by a user, mountable into session resources
--   'output' — agent wrote it to /mnt/session/outputs/* (scope_id = session_id)
--
-- scope_id: when purpose='output', points to the session that produced it.
-- When purpose='agent', null until mounted into a session.
--
-- 10 MB hard cap enforced in the API layer, not SQL — cheaper to reject at
-- the handler than to dump body bytes into the DB and rollback.
CREATE TABLE IF NOT EXISTS files (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id text REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  purpose text NOT NULL,
  scope_id text,
  content_type text,
  size_bytes integer NOT NULL DEFAULT 0,
  storage_ref text NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  archived_at timestamp,
  CONSTRAINT files_purpose_chk CHECK (purpose IN ('agent', 'output'))
);

CREATE INDEX IF NOT EXISTS idx_files_user ON files (user_id);
CREATE INDEX IF NOT EXISTS idx_files_scope ON files (scope_id) WHERE scope_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_files_purpose ON files (purpose);
CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC);

CREATE TABLE IF NOT EXISTS file_payloads (
  storage_ref text PRIMARY KEY,
  payload_bytes bytea NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
