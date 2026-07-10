CREATE TABLE IF NOT EXISTS "preview_control_artifacts" (
  "id" text PRIMARY KEY NOT NULL,
  "preview_name" text NOT NULL,
  "environment_request_id" text NOT NULL,
  "execution_id" text NOT NULL,
  "source_artifact_id" text NOT NULL,
  "file_id" text NOT NULL REFERENCES "files"("id") ON DELETE RESTRICT,
  "file_digest" text NOT NULL,
  "artifact_snapshot" jsonb NOT NULL,
  "platform_revision" text NOT NULL,
  "source_revision" text NOT NULL,
  "catalog_digest" text NOT NULL,
  "services" jsonb NOT NULL,
  "capture_id" text NOT NULL,
  "generation" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_preview_control_artifact_source_identity"
  ON "preview_control_artifacts" ("preview_name", "environment_request_id", "execution_id", "source_artifact_id");
CREATE INDEX IF NOT EXISTS "idx_preview_control_artifact_request"
  ON "preview_control_artifacts" ("preview_name", "environment_request_id");
