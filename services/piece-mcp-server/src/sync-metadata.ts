#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import pg from "pg";
import {
	DEFAULT_PLATFORM_ID,
	buildPieceCatalogRows,
	type PieceCatalogRow,
} from "./metadata-catalog.js";

type CliOptions = {
	dryRun: boolean;
	platformId: string;
	sourceImage: string | null;
	pieceNames: string[];
};

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		dryRun: false,
		platformId: process.env.PLATFORM_ID?.trim() || DEFAULT_PLATFORM_ID,
		sourceImage:
			process.env.CATALOG_SOURCE_IMAGE?.trim() ||
			process.env.PIECE_MCP_IMAGE?.trim() ||
			null,
		pieceNames: [],
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

function rowValues(row: PieceCatalogRow): unknown[] {
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
	];
}

async function upsertRows(client: pg.Client, rows: PieceCatalogRow[]): Promise<void> {
	const sql = `
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
			catalog_synced_at,
			created_at,
			updated_at
		)
		VALUES (
			$1,
			$2,
			$3,
			$4,
			$5,
			$6,
			$7,
			$8,
			$9,
			$10,
			$11::jsonb,
			$12::jsonb,
			$13::jsonb,
			$14,
			$15,
			$16,
			$17,
			$18,
			$19,
			now(),
			now(),
			now()
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
			catalog_synced_at = EXCLUDED.catalog_synced_at,
			updated_at = now()
	`;

	await client.query("BEGIN");
	try {
		for (const row of rows) {
			await client.query(sql, rowValues(row));
		}
		await client.query("COMMIT");
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	}
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const rows = buildPieceCatalogRows({
		platformId: options.platformId,
		sourceImage: options.sourceImage,
		pieceNames: options.pieceNames,
	});

	console.log(
		`[piece-mcp-metadata] generated ${rows.length} piece catalog rows (schemaVersion=${rows[0]?.catalogSchemaVersion ?? "n/a"})`,
	);
	for (const row of rows.slice(0, 8)) {
		console.log(
			`[piece-mcp-metadata] ${row.name}@${row.version} actions=${Object.keys(row.actions).length} digest=${row.catalogDigest}`,
		);
	}
	if (rows.length > 8) {
		console.log(`[piece-mcp-metadata] ... and ${rows.length - 8} more`);
	}

	if (options.dryRun) return;

	const client = new pg.Client({
		connectionString: requiredDatabaseUrl(),
	});
	await client.connect();
	try {
		await upsertRows(client, rows);
		console.log(`[piece-mcp-metadata] upserted ${rows.length} piece_metadata rows`);
	} finally {
		await client.end();
	}
}

main().catch((error) => {
	console.error("[piece-mcp-metadata] failed:", error);
	process.exit(1);
});
