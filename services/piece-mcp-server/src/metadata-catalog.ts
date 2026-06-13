/**
 * Bundled-runtime piece catalog surface.
 *
 * The pure, bundle-free row-builder + types live in metadata-row.ts (so the
 * snapshot generator can build a single piece's row in isolation). This module
 * is the BUNDLED entrypoint: it re-exports the row-builder and adds the two
 * functions that need the full bundle — `buildPieceCatalogRows` (iterates the
 * imported PIECES set) and `validateCatalogMetadata` (digest-checks a DB row
 * against the running image). Both inject the REAL `extensionsFor` so digests
 * for bundled pieces (e.g. microsoft-onedrive + its extensions) are identical
 * to what they were before the row-builder was extracted.
 */
import type { Piece } from "@activepieces/pieces-framework";
import { extensionsFor } from "./extensions/index.js";
import {
	buildPieceCatalogRow,
	CATALOG_SCHEMA_VERSION,
	isRecord,
	type PieceCatalogRow,
} from "./metadata-row.js";
import { normalizePieceName } from "./piece-name.js";
import { PIECES } from "./piece-registry.js";

// Re-export the pure row-builder, types, and constants so existing
// `from "./metadata-catalog.js"` importers (sync-metadata, index, tests) keep
// working unchanged.
export * from "./metadata-row.js";

export function buildPieceCatalogRows(options: {
	platformId?: string;
	sourceImage?: string | null;
	pieceNames?: string[];
} = {}): PieceCatalogRow[] {
	const names = options.pieceNames?.length
		? options.pieceNames.map(normalizePieceName)
		: Object.keys(PIECES);
	return names
		.map((pieceName) => {
			const piece = PIECES[pieceName];
			if (!piece) throw new Error(`Piece "${pieceName}" is not in the registry`);
			return buildPieceCatalogRow({
				pieceName,
				piece,
				platformId: options.platformId,
				sourceImage: options.sourceImage,
				extensionsFor,
			});
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function validateCatalogMetadata(input: {
	pieceName: string;
	piece: Piece;
	row: {
		actions: Record<string, unknown> | null;
		catalogSchemaVersion: number | null;
		catalogDigest: string | null;
	};
}): PieceCatalogRow {
	const expected = buildPieceCatalogRow({
		pieceName: input.pieceName,
		piece: input.piece,
		extensionsFor,
	});
	if (input.row.catalogSchemaVersion !== CATALOG_SCHEMA_VERSION) {
		throw new Error(
			`piece_metadata for "${input.pieceName}" is legacy or missing catalog_schema_version=${CATALOG_SCHEMA_VERSION}`,
		);
	}
	if (!input.row.catalogDigest) {
		throw new Error(
			`piece_metadata for "${input.pieceName}" is missing catalog_digest`,
		);
	}
	if (input.row.catalogDigest !== expected.catalogDigest) {
		throw new Error(
			`piece_metadata digest mismatch for "${input.pieceName}": db=${input.row.catalogDigest} runtime=${expected.catalogDigest}`,
		);
	}
	if (!isRecord(input.row.actions) || Object.keys(input.row.actions).length === 0) {
		throw new Error(`piece_metadata for "${input.pieceName}" has no actions`);
	}
	for (const [actionName, expectedAction] of Object.entries(expected.actions)) {
		const rawAction = input.row.actions[actionName];
		if (!isRecord(rawAction)) {
			throw new Error(
				`piece_metadata for "${input.pieceName}" is missing action "${actionName}"`,
			);
		}
		const schema = rawAction.inputSchema;
		if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) {
			throw new Error(
				`piece_metadata for "${input.pieceName}" action "${actionName}" is missing inputSchema`,
			);
		}
		if (
			Object.keys(expectedAction.inputSchema.properties).length > 0 &&
			Object.keys(schema.properties).length === 0
		) {
			throw new Error(
				`piece_metadata for "${input.pieceName}" action "${actionName}" has an empty inputSchema`,
			);
		}
	}
	return expected;
}
