/**
 * Single-piece dynamic loader (per-piece-image runtime — docs/per-piece-runtime-images.md).
 *
 * In a per-piece image (`piece-runtime-base` + ONE `npm install @activepieces/piece-<name>`,
 * `SINGLE_PIECE_MODE=true`), the runtime must NOT statically import the 48-piece bundle
 * (that's the whole point — bounded memory, no dep conflicts). Instead it dynamically
 * imports the single installed package at request time. This is the only piece-loading
 * code path that runs in single-piece mode; the static 48-piece `PIECES` map
 * (`piece-registry.static.ts`) is never loaded there.
 */
import type { Piece } from "@activepieces/pieces-framework";
import { normalizePieceName } from "./piece-name.js";

// biome-ignore lint/suspicious/noExplicitAny: piece module shape is dynamic
function findPieceExport(mod: Record<string, any>): Piece | undefined {
	// A createPiece() Piece exposes a callable `.actions` accessor; individual Action
	// exports do not. Prefer one that also has `.triggers`.
	const candidates = [...Object.values(mod), mod.default].filter(Boolean);
	const isPiece = (v: unknown): boolean =>
		!!v && typeof v === "object" && typeof (v as { actions?: unknown }).actions === "function";
	return (
		(candidates.find(
			(v) => isPiece(v) && typeof (v as { triggers?: unknown }).triggers === "function",
		) as Piece | undefined) ??
		(candidates.find(isPiece) as Piece | undefined) ??
		undefined
	);
}

export async function loadPieceDynamic(name: string): Promise<Piece | undefined> {
	const slug = normalizePieceName(name);
	if (!slug) return undefined;
	try {
		const mod = (await import(`@activepieces/piece-${slug}`)) as Record<string, unknown>;
		return findPieceExport(mod as Record<string, never>);
	} catch (error) {
		// MODULE_NOT_FOUND = this per-piece image doesn't carry that piece (wrong image
		// for the requested PIECE_NAME). Surface a clear, actionable message.
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`piece "${slug}" is not installed in this per-piece image (SINGLE_PIECE_MODE): ${message}`,
		);
	}
}
