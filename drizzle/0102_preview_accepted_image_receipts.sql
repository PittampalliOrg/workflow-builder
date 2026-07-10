CREATE TABLE IF NOT EXISTS "preview_accepted_image_receipts" (
  "receipt_digest" text PRIMARY KEY NOT NULL,
  "repository" text NOT NULL,
  "pull_request_number" integer NOT NULL CHECK ("pull_request_number" > 0),
  "base_sha" text NOT NULL,
  "head_sha" text NOT NULL,
  "catalog_digest" text NOT NULL,
  "context" text NOT NULL CHECK (
    "context" IN ('preview/immutable-acceptance', 'preview/activation-images')
  ),
  "attestation" text NOT NULL CHECK (
    "attestation" ~ '^v1\.[0-9a-f]{64}$'
  ),
  "subjects" jsonb NOT NULL CHECK (
    jsonb_typeof("subjects") = 'array' AND jsonb_array_length("subjects") > 0
  ),
  "created_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_preview_accepted_image_receipt_tuple_context"
  ON "preview_accepted_image_receipts" (
    "repository", "pull_request_number", "base_sha", "head_sha", "context"
  );
CREATE INDEX IF NOT EXISTS "idx_preview_accepted_image_receipt_head_context"
  ON "preview_accepted_image_receipts" ("repository", "head_sha", "context");
