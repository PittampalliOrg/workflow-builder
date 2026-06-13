-- Catalog expansion (Phase 2, docs/activepieces-catalog-expansion.md).
-- A `piece_metadata` row is "available-only" when the piece exists in the AP
-- catalog but is NOT bundled into the piece-mcp-server image. Such a row is
-- surfaced in the picker as "Available — request enablement" but is NEVER
-- provisioned by the activepieces-mcps reconciler (no code → ap-<piece>-service
-- would CrashLoop on getPiece()). Bundle-synced rows are always false.
-- INVARIANT: enabled-and-runnable ⊆ bundled. Default false ⇒ every existing
-- bundle-synced row keeps its current (runnable) semantics — NO-OP on deploy.
ALTER TABLE "piece_metadata" ADD COLUMN IF NOT EXISTS "available_only" boolean DEFAULT false NOT NULL;
