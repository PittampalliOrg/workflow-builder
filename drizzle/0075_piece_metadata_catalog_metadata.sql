ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_schema_version" integer;--> statement-breakpoint
ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_digest" text;--> statement-breakpoint
ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_source_image" text;--> statement-breakpoint
ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "catalog_synced_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piece_metadata_catalog_digest" ON "piece_metadata" USING btree ("catalog_digest");
