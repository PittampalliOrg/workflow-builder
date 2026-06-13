import { error, json } from '@sveltejs/kit';
import { desc, eq, inArray } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import {
	appConnections,
	mcpConnections,
	pieceMetadata,
	platformOauthApps
} from '$lib/server/db/schema';
import { connectionBelongsToProject } from '$lib/server/app-connection-scope';
import {
	buildAvailablePieceMcpCatalogEntry,
	type AppConnectionCatalogSummary,
	type ConfiguredMcpConnectionSummary
} from '$lib/server/mcp-catalog';
import { normalizePieceName, requireSessionProjectId } from '$lib/server/mcp-connections';
import { AppConnectionStatus } from '$lib/server/types/app-connection';

function canonicalPieceName(pieceName: string): string {
	const normalized = normalizePieceName(pieceName);
	return normalized ? `@activepieces/piece-${normalized}` : pieceName;
}

function searchableText(entry: {
	pieceName: string;
	displayName: string;
	description: string | null;
	categories: string[];
	authType: string;
}): string {
	return [
		entry.pieceName,
		entry.displayName,
		entry.description ?? '',
		entry.authType,
		...entry.categories
	]
		.join(' ')
		.toLowerCase();
}

/**
 * GET /api/mcp-connections/catalog
 *
 * Browser-safe catalog of predefined piece-backed MCP servers. It includes
 * configured state and connection summaries, but never returns OAuth client
 * secrets or decrypted app/vault credentials.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	const projectId = requireSessionProjectId(locals);
	if (!db) return json({ entries: [] });

	if (!locals.session?.userId) return error(401, 'Unauthorized');

	const q = (url.searchParams.get('q') || url.searchParams.get('search') || '')
		.trim()
		.toLowerCase();
	const authOnly = url.searchParams.get('authOnly') === 'true';
	const configuredOnly = url.searchParams.get('configuredOnly') === 'true';

	const [pieces, connectionRows, mcpRows] = await Promise.all([
		db
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
		db
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
		db
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

	const pieceNames = Array.from(
		new Set(
			pieces.flatMap((piece) => {
				const normalized = normalizePieceName(piece.name);
				return [normalized, canonicalPieceName(piece.name)].filter(Boolean);
			})
		)
	);
	const oauthApps =
		pieceNames.length > 0
			? await db
					.select({
						pieceName: platformOauthApps.pieceName,
						platformId: platformOauthApps.platformId
					})
					.from(platformOauthApps)
					.where(inArray(platformOauthApps.pieceName, pieceNames))
			: [];
	const oauthConfigured = new Set(
		oauthApps
			.filter(
				(app) =>
					!locals.session?.platformId || app.platformId === locals.session.platformId
			)
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

	const mcpByPiece = new Map<string, ConfiguredMcpConnectionSummary>();
	for (const row of mcpRows) {
		if (row.sourceType !== 'nimble_piece') continue;
		const key = normalizePieceName(row.pieceName);
		if (!key) continue;
		mcpByPiece.set(key, row);
	}

	const entries = pieces
		.map((piece) => {
			const normalized = normalizePieceName(piece.name);
			const entry = buildAvailablePieceMcpCatalogEntry({
				pieceName: normalized,
				displayName: piece.displayName,
				description: piece.description,
				logoUrl: piece.logoUrl,
				categories: piece.categories,
				auth: piece.auth,
				actions: piece.actions,
				oauthAppConfigured: oauthConfigured.has(normalized),
				appConnections: appConnectionsByPiece.get(normalized) ?? [],
				mcpConnection: mcpByPiece.get(normalized) ?? null
			});
			// Available-only = AP-catalog metadata, not bundled/runnable. Surfaced for
			// discovery in the hub browse (behind the "Available to enable" filter);
			// not connectable until bundled (the "Adding piece" image-rebuild flow).
			return entry ? { ...entry, availableOnly: piece.availableOnly === true } : null;
		})
		.filter((entry) => entry !== null)
		.filter((entry) => !authOnly || entry.requiresAuth)
		.filter((entry) => !configuredOnly || Boolean(entry.mcpConnection))
		.filter((entry) => !q || searchableText(entry).includes(q))
		.sort((a, b) => a.displayName.localeCompare(b.displayName));

	return json({ entries });
};
