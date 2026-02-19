import "server-only";

import { eq, sql } from "drizzle-orm";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { db } from "@/lib/db";
import { listMcpConnections } from "@/lib/db/mcp-connections";
import { listOAuthApps } from "@/lib/db/oauth-apps";
import { listPieceMetadataSummaries } from "@/lib/db/piece-metadata";
import { appConnections } from "@/lib/db/schema";
import { listPieceServers } from "@/lib/mcp-runtime/service";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import type { McpConnectionCatalogItem } from "@/lib/types/mcp-connection";

export async function getMcpConnectionCatalog(
	projectId: string,
): Promise<McpConnectionCatalogItem[]> {
	const [pieces, oauthApps, activeConnections, runtimeServers, mcpRows] =
		await Promise.all([
			listPieceMetadataSummaries({ limit: 2000 }),
			listOAuthApps(),
			db
				.select({
					pieceName: appConnections.pieceName,
					count: sql<number>`count(*)::int`,
				})
				.from(appConnections)
				.where(eq(appConnections.status, AppConnectionStatus.ACTIVE))
				.groupBy(appConnections.pieceName),
			listPieceServers(),
			listMcpConnections({ projectId }),
		]);

	const oauthSet = new Set(
		oauthApps.map((a) => normalizePieceName(a.pieceName)),
	);
	const connectionCountByPiece = new Map(
		activeConnections.map((r) => [normalizePieceName(r.pieceName), r.count]),
	);
	const runtimeSet = new Set(
		runtimeServers.map((s) => normalizePieceName(s.pieceName)),
	);
	const enabledByPiece = new Map(
		mcpRows
			.filter((r) => r.sourceType === "nimble_piece" && r.pieceName)
			.map((r) => [normalizePieceName(r.pieceName ?? ""), r]),
	);

	const catalog: McpConnectionCatalogItem[] = pieces.map((piece) => {
		const normalized = normalizePieceName(piece.name);
		const activeConnectionCount = connectionCountByPiece.get(normalized) ?? 0;
		const existing = enabledByPiece.get(normalized);
		return {
			pieceName: normalized,
			displayName: piece.displayName,
			logoUrl: piece.logoUrl,
			description: piece.description ?? null,
			activeConnectionCount,
			hasActiveConnections: activeConnectionCount > 0,
			oauthConfigured: oauthSet.has(normalized),
			runtimeAvailable: runtimeSet.has(normalized),
			enabled: existing?.status === "ENABLED",
			connectionId: existing?.id ?? null,
		};
	});

	catalog.sort((a, b) => {
		if (a.enabled !== b.enabled) {
			return a.enabled ? -1 : 1;
		}
		if (a.hasActiveConnections !== b.hasActiveConnections) {
			return a.hasActiveConnections ? -1 : 1;
		}
		return a.displayName.localeCompare(b.displayName);
	});

	return catalog;
}
