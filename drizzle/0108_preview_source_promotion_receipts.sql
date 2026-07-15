CREATE TABLE IF NOT EXISTS "preview_source_promotion_receipts" (
  "receipt_id" text PRIMARY KEY NOT NULL,
  "artifact_id" text NOT NULL REFERENCES "preview_control_artifacts"("id") ON DELETE RESTRICT,
  "preview_name" text NOT NULL,
  "environment_request_id" text NOT NULL,
  "execution_id" text NOT NULL,
  "platform_revision" text NOT NULL CHECK ("platform_revision" ~ '^[0-9a-f]{40}$'),
  "source_revision" text NOT NULL CHECK ("source_revision" ~ '^[0-9a-f]{40}$'),
  "catalog_digest" text NOT NULL CHECK ("catalog_digest" ~ '^sha256:[0-9a-f]{64}$'),
  "repository" text NOT NULL,
  "base_branch" text NOT NULL,
  "base_sha" text NOT NULL CHECK ("base_sha" ~ '^[0-9a-f]{40}$'),
  "branch" text NOT NULL,
  "commit_sha" text NOT NULL CHECK ("commit_sha" ~ '^[0-9a-f]{40}$'),
  "pr_url" text NOT NULL,
  "pull_request_number" integer NOT NULL CHECK ("pull_request_number" > 0),
  "draft" boolean NOT NULL CHECK ("draft"),
  "services" jsonb NOT NULL CHECK (
    jsonb_typeof("services") = 'array' AND jsonb_array_length("services") > 0
  ),
  "changed_paths" jsonb NOT NULL CHECK (
    jsonb_typeof("changed_paths") = 'array' AND jsonb_array_length("changed_paths") > 0
  ),
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "preview_source_promotion_receipt_distinct_commits"
    CHECK ("base_sha" <> "commit_sha")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_preview_source_promotion_receipt_artifact"
  ON "preview_source_promotion_receipts" ("artifact_id");
CREATE INDEX IF NOT EXISTS "idx_preview_source_promotion_receipt_session_created"
  ON "preview_source_promotion_receipts" (
    "preview_name", "environment_request_id", "execution_id", "created_at"
  );
CREATE INDEX IF NOT EXISTS "idx_preview_source_promotion_receipt_pr_head"
  ON "preview_source_promotion_receipts" (
    "repository", "pull_request_number", "commit_sha"
  );
