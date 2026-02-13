import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { appConnections } from "@/lib/db/schema";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { listManagedServers } from "@/lib/k8s/piece-mcp-provisioner";

/**
 * GET /api/mcp-chat/servers/status
 *
 * List all managed piece-mcp-servers and their readiness,
 * plus any pieces with active connections that lack a server.
 */
export async function GET() {
	try {
		// Get all managed servers from K8s
		const servers = await listManagedServers();

		// Get all pieces with active connections and their count
		const activeConnections = await db
			.select({
				pieceName: appConnections.pieceName,
				count: sql<number>`count(*)::int`,
			})
			.from(appConnections)
			.where(eq(appConnections.status, AppConnectionStatus.ACTIVE))
			.groupBy(appConnections.pieceName);

		const provisionedPieces = new Set(servers.map((s) => s.pieceName));

		// Find pieces with active connections but no server
		const unprovisioned = activeConnections
			.filter((c) => !provisionedPieces.has(normalizePieceName(c.pieceName)))
			.map((c) => ({
				pieceName: normalizePieceName(c.pieceName),
				activeConnections: c.count,
			}));

		// Enrich server info with connection counts
		const connectionCountByPiece = new Map(
			activeConnections.map((c) => [
				normalizePieceName(c.pieceName),
				c.count,
			]),
		);

		const enrichedServers = servers.map((s) => ({
			...s,
			hasActiveConnection: connectionCountByPiece.has(s.pieceName),
			activeConnections: connectionCountByPiece.get(s.pieceName) ?? 0,
		}));

		return NextResponse.json({
			servers: enrichedServers,
			unprovisioned,
		});
	} catch (error) {
		console.error("[mcp-chat/servers/status] Error:", error);
		return NextResponse.json(
			{ error: "Failed to list server status" },
			{ status: 500 },
		);
	}
}
