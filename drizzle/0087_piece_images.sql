-- Per-piece runtime images (docs/per-piece-runtime-images.md). Records the dedicated
-- ghcr image for a piece (ap-piece-<name>@<version>) so the activepieces-mcps reconciler
-- can provision that piece's ap-<piece>-service from its OWN image (one piece, ~256Mi)
-- instead of the shared 48-piece bundle. A `ready` row with disabled_at IS NULL = "use the
-- per-piece image"; pieces with no ready row fall back to the bundle during migration.
-- Additive — empty table changes nothing (bundle fallback everywhere).
CREATE TABLE IF NOT EXISTS "piece_images" (
	"id" text PRIMARY KEY NOT NULL,
	"piece_name" text NOT NULL,
	"version" text NOT NULL,
	"image" text,
	"digest" text,
	"status" text DEFAULT 'building' NOT NULL,
	"error_message" text,
	"built_at" timestamp,
	"enabled_at" timestamp,
	"disabled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_piece_images_piece_version" UNIQUE("piece_name","version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_piece_images_piece_status" ON "piece_images" ("piece_name","status");
