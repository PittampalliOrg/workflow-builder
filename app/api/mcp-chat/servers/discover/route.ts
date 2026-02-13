import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appConnections } from "@/lib/db/schema";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";

type DiscoveredServer = {
	name: string;
	pieceName: string;
	url: string;
	connectionExternalId: string;
	healthy: boolean;
	toolCount: number;
	toolNames: string[];
};

/**
 * GET /api/mcp-chat/servers/discover
 *
 * Auto-discovers piece-mcp-servers running in the cluster by:
 * 1. Querying active app_connections
 * 2. Constructing the in-cluster MCP server URL for each piece
 * 3. Checking health endpoint to verify the server is running
 */
export async function GET() {
	try {
		// Find all active app_connections
		const connections = await db
			.select({
				externalId: appConnections.externalId,
				pieceName: appConnections.pieceName,
				displayName: appConnections.displayName,
			})
			.from(appConnections)
			.where(eq(appConnections.status, AppConnectionStatus.ACTIVE));

		// For each connection, check if a piece-mcp-server is running
		const results = await Promise.allSettled(
			connections.map(async (conn): Promise<DiscoveredServer | null> => {
				const pieceName = conn.pieceName;
				// Convention: k8s service name is piece-mcp-{normalizedPieceName}
				const normalized = normalizePieceName(pieceName);
				const serviceName = `piece-mcp-${normalized}`;
				const healthUrl = `http://${serviceName}:3100/health`;
				const mcpUrl = `http://${serviceName}:3100/mcp`;

				try {
					const res = await fetch(healthUrl, {
						signal: AbortSignal.timeout(3000),
					});
					if (!res.ok) return null;

					const health = (await res.json()) as {
						piece: string;
						tools: number;
						toolNames: string[];
					};

					return {
						name: conn.displayName || pieceName,
						pieceName: normalized,
						url: mcpUrl,
						connectionExternalId: conn.externalId,
						healthy: true,
						toolCount: health.tools,
						toolNames: health.toolNames ?? [],
					};
				} catch {
					// Server not running for this piece
					return null;
				}
			}),
		);

		const servers = results
			.filter(
				(r): r is PromiseFulfilledResult<DiscoveredServer | null> =>
					r.status === "fulfilled",
			)
			.map((r) => r.value)
			.filter((s): s is DiscoveredServer => s !== null);

		return NextResponse.json({ servers });
	} catch (error) {
		console.error("[mcp-chat/servers/discover] Error:", error);
		return NextResponse.json(
			{ error: "Failed to discover servers" },
			{ status: 500 },
		);
	}
}
