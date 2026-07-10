CREATE TABLE IF NOT EXISTS "preview_runtime_budgets" (
  "preview_name" text NOT NULL CHECK (
    "preview_name" ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'
  ),
  "environment_request_id" text NOT NULL CHECK (
    "environment_request_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
  ),
  "platform_revision" text NOT NULL CHECK (
    "platform_revision" ~ '^[0-9a-f]{40}$'
  ),
  "source_revision" text NOT NULL CHECK (
    "source_revision" ~ '^[0-9a-f]{40}$'
  ),
  "catalog_digest" text NOT NULL CHECK (
    "catalog_digest" ~ '^sha256:[0-9a-f]{64}$'
  ),
  "minute_started_at" timestamptz NOT NULL,
  "minute_requests" integer NOT NULL CHECK ("minute_requests" >= 0),
  "minute_reserved_tokens" integer NOT NULL CHECK ("minute_reserved_tokens" >= 0),
  "total_requests" integer NOT NULL CHECK ("total_requests" >= 0),
  "total_reserved_tokens" integer NOT NULL CHECK ("total_reserved_tokens" >= 0),
  "closed_at" timestamptz,
  "delete_after" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "pk_preview_runtime_budgets_identity" PRIMARY KEY (
    "preview_name",
    "environment_request_id",
    "platform_revision",
    "source_revision",
    "catalog_digest"
  ),
  CHECK (
    ("closed_at" IS NULL AND "delete_after" IS NULL) OR
    ("closed_at" IS NOT NULL AND "delete_after" IS NOT NULL AND "delete_after" > "closed_at")
  )
);

CREATE INDEX IF NOT EXISTS "idx_preview_runtime_budgets_updated_at"
  ON "preview_runtime_budgets" ("updated_at");
