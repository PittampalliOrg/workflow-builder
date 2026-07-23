-- Durability phase 4: files blob offload + archive-on-terminal run bundles.
--
-- Blob offload — a file's BYTES may now live in an S3-compatible object store
-- instead of the `file_payloads` bytea. `storage_backend` marks WHERE
-- (NULL/`postgres` = existing `file_payloads` keyed by `storage_ref`; `s3` =
-- object at `object_key`). Lazy migration: existing rows stay NULL and keep
-- reading from Postgres, so this is behavior-preserving until the S3 backend is
-- turned on by env.
ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "storage_backend" text;

ALTER TABLE "files"
  ADD COLUMN IF NOT EXISTS "object_key" text;

-- Archive-on-terminal marker. Set once the reconciler has written this run's
-- durable bundle to object storage; NULL is the retry obligation (a terminal run
-- is re-scanned until archived).
ALTER TABLE "workflow_executions"
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp;

-- Terminal-but-unarchived scan support. Partial (archived_at IS NULL) so the
-- index only holds the small working set of runs still awaiting an archive.
CREATE INDEX IF NOT EXISTS "idx_workflow_executions_archive_scan"
  ON "workflow_executions" ("status", "completed_at")
  WHERE "archived_at" IS NULL;
