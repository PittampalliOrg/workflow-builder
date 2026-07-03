import { and, desc, eq } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { pieceMetadata } from "$lib/server/db/schema";
import {
	getPieceCatalogDefinition,
	listPieceCatalogFunctions,
	loadPieceMetadataActionSource,
	type PieceMetadataActionSourceReader,
	type PieceMetadataActionSourceRow,
} from "$lib/server/action-catalog/piece-metadata-source";
import type { CatalogFunctionSummary } from "$lib/server/application/ports";

type Database = typeof defaultDb;

const PIECE_CATALOG_SCHEMA_VERSION = 1;

function requireDb(database: Database = defaultDb): NonNullable<Database> {
	if (!database) throw new Error("database is not configured");
	return database;
}

export class PostgresPieceMetadataActionSourceReader
	implements PieceMetadataActionSourceReader
{
	constructor(private readonly database: Database = defaultDb) {}

	async loadActionSource() {
		return loadPieceMetadataActionSource(this);
	}

	async listLatestRunnableActionRows(): Promise<PieceMetadataActionSourceRow[]> {
		const database = requireDb(this.database);
		return database
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
				description: pieceMetadata.description,
				version: pieceMetadata.version,
				auth: pieceMetadata.auth,
				actions: pieceMetadata.actions,
				categories: pieceMetadata.categories,
				catalogDigest: pieceMetadata.catalogDigest,
				catalogSourceImage: pieceMetadata.catalogSourceImage,
				availableOnly: pieceMetadata.availableOnly,
			})
			.from(pieceMetadata)
			// Available-only rows have no runnable ap-<piece>-service, so they
			// belong in connection discovery, not the canvas action catalog.
			.where(
				and(
					eq(pieceMetadata.catalogSchemaVersion, PIECE_CATALOG_SCHEMA_VERSION),
					eq(pieceMetadata.availableOnly, false),
				),
			)
			.orderBy(pieceMetadata.name, desc(pieceMetadata.catalogSyncedAt));
	}

	async listPieceCatalogFunctions(): Promise<CatalogFunctionSummary[]> {
		return listPieceCatalogFunctions(this);
	}

	async getPieceCatalogDefinition(
		name: string,
	): Promise<Record<string, unknown> | null> {
		return getPieceCatalogDefinition(this, name);
	}
}
