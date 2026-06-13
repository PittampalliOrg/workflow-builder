-- Platform-admin piece-enablement gate (Phase 1, docs/activepieces-catalog-expansion.md).
-- BLOCKLIST: a row = a piece DISABLED at the platform level; the activepieces-mcps
-- reconciler's `catalog` branch skips provisioning its ap-<piece>-service. An EMPTY
-- table = every bundled piece stays provisioned, so this migration is a NO-OP on
-- deploy (no seed) — an admin opts pieces OUT, never breaking the current surface.
CREATE TABLE IF NOT EXISTS "platform_disabled_piece" (
	"id" text PRIMARY KEY NOT NULL,
	"platform_id" text DEFAULT 'default-platform' NOT NULL,
	"piece_name" text NOT NULL,
	"disabled_by" text,
	"disabled_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "uq_platform_disabled_piece_platform_piece" UNIQUE("platform_id","piece_name")
);
