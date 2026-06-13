import { readFile } from 'node:fs/promises';
import { env } from '$env/dynamic/private';
import { desc, eq, inArray } from 'drizzle-orm';
import { connectionBelongsToProject } from '$lib/server/app-connection-scope';
import type { db } from '$lib/server/db';
import {
	appConnections,
	mcpConnections,
	pieceMetadata,
	platformOauthApps
} from '$lib/server/db/schema';
import {
	buildMcpServerAvailabilityEntry,
	parseRegisteredPieceMcpCatalog,
	type AppConnectionCatalogSummary,
	type ConfiguredMcpConnectionSummary,
	type McpServerAvailabilityEntry,
	type RegisteredPieceMcpCatalogEntry
} from '$lib/server/mcp-catalog';
import { normalizePieceName } from '$lib/server/mcp-connections';
import { AppConnectionStatus } from '$lib/server/types/app-connection';

type Database = NonNullable<typeof db>;

export type McpAvailabilityResult = {
	entries: McpServerAvailabilityEntry[];
	projectConnections: ConfiguredMcpConnectionSummary[];
	customConnections: ConfiguredMcpConnectionSummary[];
	source: {
		catalogPath: string | null;
		registeredCount: number;
	};
};

type PieceMetadataSummary = {
	name: string;
	displayName: string;
	description: string | null;
	logoUrl: string | null;
	categories: string[];
	auth: unknown;
	actions: unknown;
	availableOnly: boolean;
};

function catalogPath(): string | null {
	const path = env.ACTIVEPIECES_MCP_CATALOG_PATH?.trim();
	return path || '/app/config/mcp/servers.json';
}

export async function loadRegisteredPieceMcpCatalog(): Promise<{
	entries: RegisteredPieceMcpCatalogEntry[];
	path: string | null;
}> {
	const inline = env.ACTIVEPIECES_MCP_CATALOG_JSON?.trim();
	if (inline) {
		return { entries: parseRegisteredPieceMcpCatalog(inline), path: null };
	}

	const path = catalogPath();
	if (!path) return { entries: [], path: null };
	try {
		return {
			entries: parseRegisteredPieceMcpCatalog(await readFile(path, 'utf8')),
			path
		};
	} catch {
		return { entries: [], path };
	}
}

function canonicalPieceName(pieceName: string): string {
	const normalized = normalizePieceName(pieceName);
	return normalized ? `@activepieces/piece-${normalized}` : pieceName;
}

function pieceSearchNames(pieceName: string): string[] {
	const normalized = normalizePieceName(pieceName);
	if (!normalized) return [];
	return [normalized, canonicalPieceName(normalized)];
}

function fallbackPieceSummary(
	pieceName: string,
	registered: RegisteredPieceMcpCatalogEntry | null
): PieceMetadataSummary {
	return {
		name: canonicalPieceName(pieceName),
		displayName:
			registered?.pieceName
				.split('-')
				.filter(Boolean)
				.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
				.join(' ') || pieceName,
		description: null,
		logoUrl: null,
		categories: registered?.categories ?? [],
		auth: { type: 'NONE' },
		actions: { registered_mcp_server: {} },
		availableOnly: false
	};
}

export async function getMcpAvailability(
	database: Database,
	projectId: string,
	platformId?: string | null
): Promise<McpAvailabilityResult> {
	const { entries: registeredEntries, path } = await loadRegisteredPieceMcpCatalog();
	const registeredByPiece = new Map(
		registeredEntries.map((entry) => [entry.pieceName, entry] as const)
	);

	const [pieces, connectionRows, mcpRows] = await Promise.all([
		database
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				description: pieceMetadata.description,
				logoUrl: pieceMetadata.logoUrl,
				categories: pieceMetadata.categories,
				auth: pieceMetadata.auth,
				actions: pieceMetadata.actions,
				availableOnly: pieceMetadata.availableOnly,
				updatedAt: pieceMetadata.updatedAt
			})
			.from(pieceMetadata)
			.orderBy(pieceMetadata.name, desc(pieceMetadata.updatedAt)),
		database
			.select({
				id: appConnections.id,
				externalId: appConnections.externalId,
				displayName: appConnections.displayName,
				pieceName: appConnections.pieceName,
				type: appConnections.type,
				status: appConnections.status,
				projectIds: appConnections.projectIds
			})
			.from(appConnections)
			.where(eq(appConnections.status, AppConnectionStatus.ACTIVE))
			.orderBy(desc(appConnections.createdAt)),
		database
			.select({
				id: mcpConnections.id,
				displayName: mcpConnections.displayName,
				sourceType: mcpConnections.sourceType,
				pieceName: mcpConnections.pieceName,
				serverKey: mcpConnections.serverKey,
				connectionExternalId: mcpConnections.connectionExternalId,
				serverUrl: mcpConnections.serverUrl,
				status: mcpConnections.status,
				metadata: mcpConnections.metadata
			})
			.from(mcpConnections)
			.where(eq(mcpConnections.projectId, projectId))
	]);

	const piecesByName = new Map<string, PieceMetadataSummary>();
	for (const piece of pieces) {
		const normalized = normalizePieceName(piece.name);
		if (!normalized || piecesByName.has(normalized)) continue;
		piecesByName.set(normalized, piece);
	}

	const wantedPieces = new Set(registeredByPiece.keys());
	for (const row of mcpRows) {
		if (row.sourceType !== 'nimble_piece') continue;
		const pieceName = normalizePieceName(row.pieceName);
		if (pieceName) wantedPieces.add(pieceName);
	}
	// NOTE: available-only pieces are intentionally NOT added here. The MCP
	// availability list is about registered/connectable servers; discovery of the
	// (hundreds of) catalog-only pieces lives in the connections HUB browse
	// (/api/mcp-connections/catalog), which already has search + category filters.

	const oauthPieceNames = Array.from(
		new Set(Array.from(wantedPieces).flatMap((piece) => pieceSearchNames(piece)))
	);
	const oauthApps =
		oauthPieceNames.length > 0
			? await database
					.select({
						pieceName: platformOauthApps.pieceName,
						platformId: platformOauthApps.platformId
					})
					.from(platformOauthApps)
					.where(inArray(platformOauthApps.pieceName, oauthPieceNames))
			: [];
	const oauthConfigured = new Set(
		oauthApps
			.filter((app) => !platformId || app.platformId === platformId)
			.map((app) => normalizePieceName(app.pieceName))
	);

	const appConnectionsByPiece = new Map<string, AppConnectionCatalogSummary[]>();
	for (const row of connectionRows) {
		if (!connectionBelongsToProject(row.projectIds, projectId)) continue;
		const key = normalizePieceName(row.pieceName);
		if (!key) continue;
		const list = appConnectionsByPiece.get(key) ?? [];
		list.push({
			id: row.id,
			externalId: row.externalId,
			displayName: row.displayName,
			type: row.type,
			status: row.status
		});
		appConnectionsByPiece.set(key, list);
	}

	const projectConnections: ConfiguredMcpConnectionSummary[] = mcpRows;
	const customConnections = projectConnections.filter((row) => row.sourceType !== 'nimble_piece');

	const mcpByPiece = new Map<string, ConfiguredMcpConnectionSummary>();
	for (const row of mcpRows) {
		if (row.sourceType !== 'nimble_piece') continue;
		const key = normalizePieceName(row.pieceName);
		if (key) mcpByPiece.set(key, row);
	}

	const entries = Array.from(wantedPieces)
		.map((pieceName) => {
			const registered = registeredByPiece.get(pieceName) ?? null;
			const piece = piecesByName.get(pieceName) ?? fallbackPieceSummary(pieceName, registered);
			return buildMcpServerAvailabilityEntry({
				pieceName,
				displayName: piece.displayName,
				description: piece.description,
				logoUrl: piece.logoUrl,
				categories: piece.categories,
				auth: piece.auth,
				actions: piece.actions,
				oauthAppConfigured: oauthConfigured.has(pieceName),
				appConnections: appConnectionsByPiece.get(pieceName) ?? [],
				mcpConnection: mcpByPiece.get(pieceName) ?? null,
				registered,
				availableOnly: piece.availableOnly === true
			});
		})
		.filter((entry): entry is McpServerAvailabilityEntry => entry !== null)
		.sort((a, b) => {
			if (a.registered !== b.registered) return a.registered ? -1 : 1;
			if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
			return a.displayName.localeCompare(b.displayName);
		});

	return {
		entries,
		projectConnections,
		customConnections,
		source: {
			catalogPath: path,
			registeredCount: registeredEntries.length
		}
	};
}
