ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_schema_version" integer;

ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_digest" text;

ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_source_image" text;

ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_synced_at" timestamp;

CREATE INDEX IF NOT EXISTS "idx_piece_metadata_catalog_digest"
	ON "piece_metadata" ("catalog_digest");
