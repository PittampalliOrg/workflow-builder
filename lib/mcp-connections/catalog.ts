import "server-only";

import { eq, sql } from "drizzle-orm";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { db } from "@/lib/db";
import { listMcpConnections } from "@/lib/db/mcp-connections";
import { listOAuthApps } from "@/lib/db/oauth-apps";
import { listPieceMetadataSummaries } from "@/lib/db/piece-metadata";
import { appConnections } from "@/lib/db/schema";
import { listNimbleServers } from "@/lib/mcp-runtime/service";
import { listSharedNimbleCatalogServers } from "@/lib/mcp-runtime/shared-catalog";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import type { McpConnectionCatalogItem } from "@/lib/types/mcp-connection";

export async function getMcpConnectionCatalog(
	projectId: string,
): Promise<McpConnectionCatalogItem[]> {
	const [
		pieces,
		sharedServers,
		oauthApps,
		activeConnections,
		runtimeServers,
		mcpRows,
	] = await Promise.all([
		listPieceMetadataSummaries({ limit: 2000 }),
		listSharedNimbleCatalogServers(),
		listOAuthApps(),
		db
			.select({
				pieceName: appConnections.pieceName,
				count: sql<number>`count(*)::int`,
			})
			.from(appConnections)
			.where(eq(appConnections.status, AppConnectionStatus.ACTIVE))
			.groupBy(appConnections.pieceName),
		listNimbleServers(),
		listMcpConnections({ projectId }),
	]);

	const oauthSet = new Set(
		oauthApps.map((a) => normalizePieceName(a.pieceName)),
	);
	const connectionCountByPiece = new Map(
		activeConnections.map((r) => [normalizePieceName(r.pieceName), r.count]),
	);
	const runtimeByKey = new Map(
		runtimeServers.map((server) => [
			`${server.sourceType}:${normalizePieceName(server.pieceName ?? server.serverKey ?? "")}`,
			server,
		]),
	);
	const enabledByKey = new Map(
		mcpRows
			.filter(
				(row) =>
					row.sourceType === "nimble_piece" ||
					row.sourceType === "nimble_shared",
			)
			.map((row) => {
				const key =
					row.sourceType === "nimble_piece"
						? normalizePieceName(row.pieceName ?? "")
						: normalizePieceName(row.serverKey ?? "");
				return [`${row.sourceType}:${key}`, row];
			}),
	);

	const pieceCatalog: McpConnectionCatalogItem[] = pieces.map((piece) => {
		const normalized = normalizePieceName(piece.name);
		const activeConnectionCount = connectionCountByPiece.get(normalized) ?? 0;
		const existing = enabledByKey.get(`nimble_piece:${normalized}`);
		return {
			sourceType: "nimble_piece",
			catalogKey: normalized,
			pieceName: normalized,
			serverKey: null,
			displayName: piece.displayName,
			logoUrl: piece.logoUrl,
			description: piece.description ?? null,
			activeConnectionCount,
			hasActiveConnections: activeConnectionCount > 0,
			oauthConfigured: oauthSet.has(normalized),
			runtimeAvailable: runtimeByKey.has(`nimble_piece:${normalized}`),
			enabled: existing?.status === "ENABLED",
			connectionId: existing?.id ?? null,
		};
	});

	const sharedCatalog: McpConnectionCatalogItem[] = sharedServers.map(
		(server) => {
			const normalized = normalizePieceName(server.serverKey);
			const existing = enabledByKey.get(`nimble_shared:${normalized}`);
			const runtimeKey = `nimble_shared:${normalized}`;
			return {
				sourceType: "nimble_shared",
				catalogKey: normalized,
				pieceName: null,
				serverKey: normalized,
				displayName: server.displayName,
				logoUrl: server.logoUrl,
				description: server.description,
				activeConnectionCount: 0,
				hasActiveConnections: false,
				oauthConfigured: false,
				runtimeAvailable: runtimeByKey.has(runtimeKey),
				enabled: existing?.status === "ENABLED",
				connectionId: existing?.id ?? null,
			};
		},
	);

	const catalog = [...pieceCatalog, ...sharedCatalog];

	catalog.sort((a, b) => {
		if (a.enabled !== b.enabled) {
			return a.enabled ? -1 : 1;
		}
		if (a.hasActiveConnections !== b.hasActiveConnections) {
			return a.hasActiveConnections ? -1 : 1;
		}
		if (a.sourceType !== b.sourceType) {
			return a.sourceType === "nimble_piece" ? -1 : 1;
		}
		return a.displayName.localeCompare(b.displayName);
	});

	return catalog;
}
