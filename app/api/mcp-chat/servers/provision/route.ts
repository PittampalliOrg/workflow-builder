import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appConnections } from "@/lib/db/schema";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import {
	ensurePieceMcpServer,
	serviceNameForPiece,
} from "@/lib/k8s/piece-mcp-provisioner";

type ProvisionResult = {
	pieceName: string;
	serviceName: string;
	action: "created" | "already_exists" | "error";
	error?: string;
};

/**
 * POST /api/mcp-chat/servers/provision
 *
 * Provision piece-mcp-servers for pieces with active connections.
 * Body: { pieceName?: string }  — omit for bulk (all active connections)
 */
export async function POST(request: Request) {
	try {
		const body = (await request.json().catch(() => ({}))) as {
			pieceName?: string;
		};

		type PieceToProvision = {
			pieceName: string;
			externalId?: string;
		};

		let pieces: PieceToProvision[];

		if (body.pieceName) {
			// Single piece: look up its connection externalId
			const conn = await db
				.select({
					pieceName: appConnections.pieceName,
					externalId: appConnections.externalId,
				})
				.from(appConnections)
				.where(eq(appConnections.pieceName, body.pieceName))
				.limit(1);

			pieces = [
				{
					pieceName: body.pieceName,
					externalId: conn[0]?.externalId,
				},
			];
		} else {
			// Bulk: find all distinct piece names with active connections
			const connections = await db
				.select({
					pieceName: appConnections.pieceName,
					externalId: appConnections.externalId,
				})
				.from(appConnections)
				.where(eq(appConnections.status, AppConnectionStatus.ACTIVE));

			// Deduplicate by pieceName (take first connection's externalId)
			const seen = new Map<string, string | undefined>();
			for (const c of connections) {
				if (!seen.has(c.pieceName)) {
					seen.set(c.pieceName, c.externalId);
				}
			}
			pieces = Array.from(seen.entries()).map(([pieceName, externalId]) => ({
				pieceName,
				externalId,
			}));
		}

		const results: ProvisionResult[] = await Promise.all(
			pieces.map(async (p): Promise<ProvisionResult> => {
				const normalized = normalizePieceName(p.pieceName);
				const serviceName = serviceNameForPiece(p.pieceName);

				try {
					const { created } = await ensurePieceMcpServer(
						p.pieceName,
						p.externalId,
					);
					return {
						pieceName: normalized,
						serviceName,
						action: created ? "created" : "already_exists",
					};
				} catch (err) {
					return {
						pieceName: normalized,
						serviceName,
						action: "error",
						error: err instanceof Error ? err.message : "Unknown error",
					};
				}
			}),
		);

		return NextResponse.json({ results });
	} catch (error) {
		console.error("[mcp-chat/servers/provision] Error:", error);
		return NextResponse.json(
			{ error: "Failed to provision servers" },
			{ status: 500 },
		);
	}
}
