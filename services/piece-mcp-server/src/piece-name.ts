/**
 * Pure piece-name normalization — AP convention (lowercase-dashed, no
 * `@activepieces/piece-` prefix).
 *
 * Extracted from piece-registry.ts so the metadata row-builder (metadata-row.ts)
 * can normalize names WITHOUT importing piece-registry.ts, which eagerly loads
 * the full bundled PIECES set (47 `@activepieces/piece-*` packages). The catalog
 * snapshot generator (gen-catalog-snapshot.ts) imports the row-builder against a
 * SINGLE isolated-installed piece, where loading 47 packages would crash.
 */
export function normalizePieceName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, "")
		.replace(/[_\s]+/g, "-")
		.replace(/-+/g, "-");
}
