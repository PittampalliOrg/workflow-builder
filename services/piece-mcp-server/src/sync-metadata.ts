#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import type { CatalogSnapshot, SnapshotPiece } from "./catalog-snapshot-types.js";
import {
	DEFAULT_PLATFORM_ID,
	buildPieceCatalogRows,
	type PieceCatalogRow,
} from "./metadata-catalog.js";

// Use the native __dirname: present in the esbuild CJS bundle (prod runs
// `node dist/sync-metadata.js` → /app/dist) and injected by tsx in dev (→ src/).
// `import.meta.url` would be undefined in the CJS bundle and crash at load.
declare const __dirname: string;

/**
 * A DB-insertable piece_metadata row. The BUNDLE pass derives these from the
 * imported PIECES (full action metadata, available_only=false). The SNAPSHOT
 * pass derives them from the committed catalog snapshot (slim, code-free,
 * available_only=true). See docs/activepieces-catalog-expansion.md.
 */
type UpsertRow = {
	name: string;
	authors: string[];
	displayName: string;
	logoUrl: string;
	description: string | null;
	platformId: string;
	version: string;
	minimumSupportedRelease: string;
	maximumSupportedRelease: string;
	auth: unknown;
	actions: unknown;
	triggers: unknown;
	pieceType: string;
	categories: string[];
	packageType: string;
	catalogSchemaVersion: number;
	catalogDigest: string | null;
	catalogSourceImage: string | null;
	availableOnly: boolean;
};

type CliOptions = {
	dryRun: boolean;
	platformId: string;
	sourceImage: string | null;
	pieceNames: string[];
	seedSnapshot: boolean;
	snapshotPath: string;
};

function defaultSnapshotPath(): string {
	// build.mjs copies src/piece-catalog-snapshot.json → dist/; __dirname is
	// dist/ in the image and src/ under tsx, so this resolves in both.
	return resolve(__dirname, "piece-catalog-snapshot.json");
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		dryRun: false,
		platformId: process.env.PLATFORM_ID?.trim() || DEFAULT_PLATFORM_ID,
		sourceImage:
			process.env.CATALOG_SOURCE_IMAGE?.trim() ||
			process.env.PIECE_MCP_IMAGE?.trim() ||
			null,
		pieceNames: [],
		seedSnapshot: process.env.CATALOG_SEED_SNAPSHOT !== "false",
		snapshotPath: process.env.CATALOG_SNAPSHOT_PATH?.trim() || defaultSnapshotPath(),
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			options.dryRun = true;
		} else if (arg === "--platform-id") {
			options.platformId = argv[++i] ?? options.platformId;
		} else if (arg.startsWith("--platform-id=")) {
			options.platformId = arg.slice("--platform-id=".length);
		} else if (arg === "--source-image") {
			options.sourceImage = argv[++i] ?? options.sourceImage;
		} else if (arg.startsWith("--source-image=")) {
			options.sourceImage = arg.slice("--source-image=".length);
		} else if (arg === "--piece") {
			options.pieceNames.push(argv[++i] ?? "");
		} else if (arg.startsWith("--piece=")) {
			options.pieceNames.push(arg.slice("--piece=".length));
		} else if (arg === "--snapshot") {
			options.snapshotPath = resolve(argv[++i] ?? options.snapshotPath);
		} else if (arg.startsWith("--snapshot=")) {
			options.snapshotPath = resolve(arg.slice("--snapshot=".length));
		} else if (arg === "--no-snapshot") {
			options.seedSnapshot = false;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	options.pieceNames = options.pieceNames
		.map((piece) => piece.trim())
		.filter(Boolean);
	return options;
}

function requiredDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("DATABASE_URL is required");
	return databaseUrl;
}

/** Bundle-derived (runnable) row → DB row with available_only=false. */
function bundleRowToUpsert(row: PieceCatalogRow): UpsertRow {
	return {
		name: row.name,
		authors: row.authors,
		displayName: row.displayName,
		logoUrl: row.logoUrl,
		description: row.description,
		platformId: row.platformId,
		version: row.version,
		minimumSupportedRelease: row.minimumSupportedRelease,
		maximumSupportedRelease: row.maximumSupportedRelease,
		auth: row.auth,
		actions: row.actions,
		triggers: row.triggers,
		pieceType: row.pieceType,
		categories: row.categories,
		packageType: row.packageType,
		catalogSchemaVersion: row.catalogSchemaVersion,
		catalogDigest: row.catalogDigest,
		catalogSourceImage: row.catalogSourceImage,
		availableOnly: false,
	};
}

/** Snapshot-derived (catalog-only) piece → DB row with available_only=true. */
function snapshotPieceToUpsert(p: SnapshotPiece, platformId: string): UpsertRow {
	return {
		name: p.name,
		authors: p.authors,
		displayName: p.displayName,
		logoUrl: p.logoUrl,
		description: p.description,
		platformId,
		version: p.version,
		minimumSupportedRelease: p.minimumSupportedRelease,
		maximumSupportedRelease: p.maximumSupportedRelease,
		// the full auth descriptor is dropped from the snapshot; keep just the
		// type so the UI can show the credential kind for an available-only piece.
		auth: p.authType ? { type: p.authType } : null,
		actions: p.actions,
		triggers: p.triggers,
		pieceType: p.pieceType,
		categories: p.categories,
		packageType: p.packageType,
		catalogSchemaVersion: p.catalogSchemaVersion,
		catalogDigest: p.catalogDigest,
		catalogSourceImage: null,
		availableOnly: true,
	};
}

function rowValues(row: UpsertRow): unknown[] {
	return [
		randomUUID(),
		row.name,
		row.authors,
		row.displayName,
		row.logoUrl,
		row.description,
		row.platformId,
		row.version,
		row.minimumSupportedRelease,
		row.maximumSupportedRelease,
		JSON.stringify(row.auth),
		JSON.stringify(row.actions),
		JSON.stringify(row.triggers),
		row.pieceType,
		row.categories,
		row.packageType,
		row.catalogSchemaVersion,
		row.catalogDigest,
		row.catalogSourceImage,
		row.availableOnly,
	];
}

const UPSERT_SQL = `
	INSERT INTO piece_metadata (
		id,
		name,
		authors,
		display_name,
		logo_url,
		description,
		platform_id,
		version,
		minimum_supported_release,
		maximum_supported_release,
		auth,
		actions,
		triggers,
		piece_type,
		categories,
		package_type,
		catalog_schema_version,
		catalog_digest,
		catalog_source_image,
		available_only,
		catalog_synced_at,
		created_at,
		updated_at
	)
	VALUES (
		$1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
		$11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19, $20,
		now(), now(), now()
	)
	ON CONFLICT (name, version, platform_id) DO UPDATE SET
		authors = EXCLUDED.authors,
		display_name = EXCLUDED.display_name,
		logo_url = EXCLUDED.logo_url,
		description = EXCLUDED.description,
		minimum_supported_release = EXCLUDED.minimum_supported_release,
		maximum_supported_release = EXCLUDED.maximum_supported_release,
		auth = EXCLUDED.auth,
		actions = EXCLUDED.actions,
		triggers = EXCLUDED.triggers,
		piece_type = EXCLUDED.piece_type,
		categories = EXCLUDED.categories,
		package_type = EXCLUDED.package_type,
		catalog_schema_version = EXCLUDED.catalog_schema_version,
		catalog_digest = EXCLUDED.catalog_digest,
		catalog_source_image = EXCLUDED.catalog_source_image,
		available_only = EXCLUDED.available_only,
		catalog_synced_at = EXCLUDED.catalog_synced_at,
		updated_at = now()
`;

function loadSnapshot(path: string): CatalogSnapshot | null {
	if (!existsSync(path)) return null;
	const parsed = JSON.parse(readFileSync(path, "utf8")) as CatalogSnapshot;
	if (!Array.isArray(parsed.pieces)) {
		throw new Error(`snapshot at ${path} has no pieces[]`);
	}
	return parsed;
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	// Pass 1 — BUNDLE (runnable). Always runs; the source of truth for
	// available_only=false rows + the set of bundled piece names.
	const bundleRows = buildPieceCatalogRows({
		platformId: options.platformId,
		sourceImage: options.sourceImage,
		pieceNames: options.pieceNames,
	}).map(bundleRowToUpsert);
	const bundledNames = new Set(bundleRows.map((r) => r.name));

	// Pass 2 — SNAPSHOT (catalog-only). Available-only rows for pieces NOT in the
	// bundle. Skipped when --piece filters are given (targeted bundle re-sync).
	let snapshotRows: UpsertRow[] = [];
	let snapshotLoaded = false;
	if (options.seedSnapshot && options.pieceNames.length === 0) {
		const snapshot = loadSnapshot(options.snapshotPath);
		if (snapshot) {
			snapshotLoaded = true;
			snapshotRows = snapshot.pieces
				.filter((p) => !bundledNames.has(p.name))
				.map((p) => snapshotPieceToUpsert(p, options.platformId));
		} else {
			console.log(
				`[piece-mcp-metadata] no catalog snapshot at ${options.snapshotPath} — bundle-only sync`,
			);
		}
	}
	const availableOnlyNames = snapshotRows.map((r) => r.name);

	console.log(
		`[piece-mcp-metadata] bundle=${bundleRows.length} runnable, available-only=${snapshotRows.length} (snapshot ${snapshotLoaded ? "loaded" : "absent"})`,
	);
	for (const row of bundleRows.slice(0, 6)) {
		console.log(
			`[piece-mcp-metadata] bundle ${row.name}@${row.version} actions=${Object.keys(row.actions as object).length} digest=${row.catalogDigest}`,
		);
	}

	if (options.dryRun) return;

	const client = new pg.Client({ connectionString: requiredDatabaseUrl() });
	await client.connect();
	try {
		await client.query("BEGIN");
		for (const row of bundleRows) {
			await client.query(UPSERT_SQL, rowValues(row));
		}
		for (const row of snapshotRows) {
			await client.query(UPSERT_SQL, rowValues(row));
		}

		// Cleanup, scoped to this platform. Only prune available-only rows when a
		// snapshot actually loaded — otherwise leave existing available-only rows
		// untouched (a bundle-only sync must never wipe the catalog).
		if (snapshotLoaded) {
			// A piece promoted INTO the bundle keeps no stale available-only row;
			// a piece removed FROM the catalog is pruned. Both: available_only rows
			// whose name is not in the freshly-seeded available-only set.
			const del = await client.query(
				`DELETE FROM piece_metadata
				   WHERE platform_id = $1 AND available_only = true AND name <> ALL($2::text[])`,
				[options.platformId, availableOnlyNames],
			);
			if (del.rowCount) {
				console.log(
					`[piece-mcp-metadata] pruned ${del.rowCount} stale available-only row(s)`,
				);
			}
		}

		await client.query("COMMIT");
		console.log(
			`[piece-mcp-metadata] upserted ${bundleRows.length} runnable + ${snapshotRows.length} available-only piece_metadata rows`,
		);
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("[piece-mcp-metadata] failed:", error);
	process.exit(1);
});
