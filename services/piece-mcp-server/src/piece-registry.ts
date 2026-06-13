/**
 * Piece Registry — the piece-loading seam.
 *
 * Two runtime modes (docs/per-piece-runtime-images.md):
 *  - BUNDLE (default): all 48 pieces are compiled in; `PIECES` (from
 *    piece-registry.static.ts) is the static map and getPiece is a map lookup.
 *  - SINGLE_PIECE_MODE=true (per-piece image): only ONE @activepieces/piece-<name> is
 *    installed; getPiece loads it dynamically (dynamic-registry.ts) and `PIECES` is {}.
 *
 * In a single/base image build, build.mjs (BUILD_VARIANT=single) resolves
 * ./piece-registry.static.js to ./piece-registry.empty.js, so the 48 eager piece
 * `require()`s never reach dist. getPiece is async so the same call site
 * (index.ts main()) works in both modes.
 */
import type { Piece } from "@activepieces/pieces-framework";
import { loadPieceDynamic } from "./dynamic-registry.js";
import { normalizePieceName } from "./piece-name.js";
// build.mjs aliases this to piece-registry.empty.js in single-piece builds.
import { PIECES } from "./piece-registry.static.js";

// normalizePieceName lives in the bundle-free piece-name.ts so the metadata
// row-builder + snapshot generator can use it without loading PIECES. Re-export
// keeps every existing `from "./piece-registry.js"` importer working.
export { normalizePieceName };
// PIECES is {} in single-piece mode; only the bundle path / sync-metadata read it.
export { PIECES };

const SINGLE_PIECE_MODE = process.env.SINGLE_PIECE_MODE === "true";

/**
 * Get a piece by normalized name. Async so single-piece mode can dynamically import
 * the one installed package; the bundle path resolves immediately from the static map.
 */
export async function getPiece(name: string): Promise<Piece | undefined> {
	if (SINGLE_PIECE_MODE) return loadPieceDynamic(name);
	return PIECES[normalizePieceName(name)];
}

/**
 * List registered piece names. In single-piece mode the only available piece is the
 * one this image carries (PIECE_NAME).
 */
export function listPieceNames(): string[] {
	if (SINGLE_PIECE_MODE) {
		const only = normalizePieceName(process.env.PIECE_NAME ?? "");
		return only ? [only] : [];
	}
	return Object.keys(PIECES);
}
