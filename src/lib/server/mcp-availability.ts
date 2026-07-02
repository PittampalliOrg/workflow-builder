import { readFile } from 'node:fs/promises';
import { env } from '$env/dynamic/private';
import type {
	McpAvailabilityReadModel,
	McpCatalogAppConnectionSummary,
	McpCatalogConfiguredConnectionSummary,
	McpCatalogPieceRecord
} from '$lib/server/application/ports';
import {
	buildMcpServerAvailabilityEntry,
	parseRegisteredPieceMcpCatalog,
	type McpServerAvailabilityEntry,
	type RegisteredPieceMcpCatalogEntry
} from '$lib/server/mcp-catalog';
import { normalizePieceName } from '$lib/server/mcp-connections';

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

export type BuildMcpAvailabilityInput = {
	registeredEntries: RegisteredPieceMcpCatalogEntry[];
	catalogPath: string | null;
	pieces: McpCatalogPieceRecord[];
	appConnections: McpCatalogAppConnectionSummary[];
	projectConnections: McpCatalogConfiguredConnectionSummary[];
	oauthConfiguredPieceNames: string[];
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

export function getMcpAvailabilityWantedPieceNames(input: {
	registeredEntries: RegisteredPieceMcpCatalogEntry[];
	projectConnections: McpCatalogConfiguredConnectionSummary[];
}): string[] {
	const wantedPieces = new Set(input.registeredEntries.map((entry) => entry.pieceName));
	for (const row of input.projectConnections) {
		if (row.sourceType !== 'nimble_piece') continue;
		const pieceName = normalizePieceName(row.pieceName);
		if (pieceName) wantedPieces.add(pieceName);
	}
	return Array.from(wantedPieces);
}

export function getMcpAvailabilityOAuthPieceNames(pieceNames: string[]): string[] {
	return Array.from(new Set(pieceNames.flatMap((piece) => pieceSearchNames(piece))));
}

export function buildMcpAvailability(
	input: BuildMcpAvailabilityInput
): McpAvailabilityReadModel {
	const registeredByPiece = new Map(
		input.registeredEntries.map((entry) => [entry.pieceName, entry] as const)
	);

	const piecesByName = new Map<string, PieceMetadataSummary>();
	for (const piece of input.pieces) {
		const normalized = normalizePieceName(piece.name);
		if (!normalized || piecesByName.has(normalized)) continue;
		piecesByName.set(normalized, piece);
	}

	const wantedPieces = getMcpAvailabilityWantedPieceNames({
		registeredEntries: input.registeredEntries,
		projectConnections: input.projectConnections
	});
	// NOTE: available-only pieces are intentionally NOT added here. The MCP
	// availability list is about registered/connectable servers; discovery of the
	// (hundreds of) catalog-only pieces lives in the connections HUB browse
	// (/api/mcp-connections/catalog), which already has search + category filters.
	const oauthConfigured = new Set(
		input.oauthConfiguredPieceNames.map((pieceName) => normalizePieceName(pieceName))
	);

	const appConnectionsByPiece = new Map<
		string,
		Omit<McpCatalogAppConnectionSummary, 'pieceName'>[]
	>();
	for (const row of input.appConnections) {
		const key = normalizePieceName(row.pieceName);
		if (!key) continue;
		const list = appConnectionsByPiece.get(key) ?? [];
		const { pieceName: _pieceName, ...summary } = row;
		list.push({
			id: summary.id,
			externalId: summary.externalId,
			displayName: summary.displayName,
			type: summary.type,
			status: summary.status
		});
		appConnectionsByPiece.set(key, list);
	}

	const projectConnections = input.projectConnections;
	const customConnections = projectConnections.filter((row) => row.sourceType !== 'nimble_piece');

	const mcpByPiece = new Map<string, McpCatalogConfiguredConnectionSummary>();
	for (const row of input.projectConnections) {
		if (row.sourceType !== 'nimble_piece') continue;
		const key = normalizePieceName(row.pieceName);
		if (key) mcpByPiece.set(key, row);
	}

	const entries: McpServerAvailabilityEntry[] = wantedPieces
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
			catalogPath: input.catalogPath,
			registeredCount: input.registeredEntries.length
		}
	};
}
