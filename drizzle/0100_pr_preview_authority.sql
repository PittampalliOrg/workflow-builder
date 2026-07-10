-- Persist the server-derived PR, catalog, and platform facts used to launch a
-- unified PreviewEnvironment. Legacy rows remain NULL and fail closed on resume.
ALTER TABLE "pr_previews"
  ADD COLUMN IF NOT EXISTS "authority" jsonb;
