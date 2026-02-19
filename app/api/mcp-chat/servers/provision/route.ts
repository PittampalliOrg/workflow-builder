import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { upsertPieceMcpConnection } from "@/lib/db/mcp-connections";
import { appConnections } from "@/lib/db/schema";
import { ensurePieceServer } from "@/lib/mcp-runtime/service";
import { getUserProjectRole } from "@/lib/project-service";
import { AppConnectionStatus } from "@/lib/types/app-connection";

type ProvisionResult = {
	pieceName: string;
	action: "enabled" | "error";
	serverUrl: string | null;
	error?: string;
};

function canWrite(role: string) {
	return role === "ADMIN" || role === "EDITOR";
}

/**
 * POST /api/mcp-chat/servers/provision
 *
 * Enable managed MCP connections for one piece or all pieces with active
 * app connections in the current project.
 */
export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const role = await getUserProjectRole(
			session.user.id,
			session.user.projectId,
		);
		if (!(role && canWrite(role))) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const body = (await request.json().catch(() => ({}))) as {
			pieceName?: string;
		};

		const pieces = body.pieceName
			? [normalizePieceName(body.pieceName)]
			: (
					await db
						.selectDistinct({ pieceName: appConnections.pieceName })
						.from(appConnections)
						.where(eq(appConnections.status, AppConnectionStatus.ACTIVE))
				).map((row) => normalizePieceName(row.pieceName));

		const results: ProvisionResult[] = [];
		for (const pieceName of pieces) {
			try {
				const ensured = await ensurePieceServer({ pieceName });
				await upsertPieceMcpConnection({
					projectId: session.user.projectId,
					pieceName,
					displayName: pieceName,
					status: ensured.server?.healthy ? "ENABLED" : "ERROR",
					serverUrl: ensured.server?.url ?? null,
					registryRef: ensured.server?.registryRef ?? null,
					lastError: ensured.server?.healthy
						? null
						: (ensured.error ?? "Server unavailable"),
					metadata: ensured.server
						? {
								provider: ensured.server.provider,
								serviceName: ensured.server.serviceName,
							}
						: null,
					actorUserId: session.user.id,
				});
				results.push({
					pieceName,
					action: ensured.server?.healthy ? "enabled" : "error",
					serverUrl: ensured.server?.url ?? null,
					error: ensured.server?.healthy ? undefined : ensured.error,
				});
			} catch (error) {
				results.push({
					pieceName,
					action: "error",
					serverUrl: null,
					error: error instanceof Error ? error.message : "Unknown error",
				});
			}
		}

		return NextResponse.json({ results });
	} catch (error) {
		console.error("[mcp-chat/servers/provision] Error:", error);
		return NextResponse.json(
			{ error: "Failed to provision servers" },
			{ status: 500 },
		);
	}
}
