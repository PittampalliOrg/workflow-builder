/**
 * Shared types for the code-free piece catalog snapshot — produced by
 * gen-catalog-snapshot.ts (CI) and consumed by sync-metadata.ts (deploy-time
 * seed). See docs/activepieces-catalog-expansion.md.
 */

/**
 * Slim per-action/trigger projection. Available-only pieces are never run, so
 * the heavy `inputSchema`/`props`/`fieldSummaries`/`requiredFields` are dropped
 * (cuts the snapshot ~10×). If a piece is promoted to the bundle, the real sync
 * recomputes full metadata.
 */
export type SlimOperation = {
	name: string;
	displayName: string;
	description: string | null;
	requireAuth: boolean;
};

export type SnapshotPiece = {
	name: string;
	authors: string[];
	displayName: string;
	logoUrl: string;
	description: string | null;
	version: string;
	minimumSupportedRelease: string;
	maximumSupportedRelease: string;
	authType: string | null;
	categories: string[];
	pieceType: string;
	packageType: string;
	catalogSchemaVersion: number;
	catalogDigest: string;
	actions: Record<string, SlimOperation>;
	triggers: Record<string, SlimOperation>;
	sourcePackage: string;
};

export type CatalogSnapshot = {
	snapshotSchemaVersion: number;
	catalogSchemaVersion: number;
	generatedAt: string;
	generator: string;
	count: number;
	failures: { pkg: string; error: string }[];
	/** AP CORE-primitive pieces (no auth) excluded as non-connectable built-ins. */
	excludedCore?: string[];
	pieces: SnapshotPiece[];
};
