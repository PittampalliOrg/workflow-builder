import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { listMcpConnections } from "@/lib/db/mcp-connections";
import { getUserProjectRole } from "@/lib/project-service";

/**
 * GET /api/mcp-chat/servers/status
 *
 * Lists project-scoped MCP connection records and their statuses.
 */
export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const role = await getUserProjectRole(
			session.user.id,
			session.user.projectId,
		);
		if (!role) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const rows = await listMcpConnections({
			projectId: session.user.projectId,
		});
		return NextResponse.json({
			servers: rows.map((row) => ({
				id: row.id,
				name: row.displayName,
				pieceName: row.pieceName,
				url: row.serverUrl,
				status: row.status,
				sourceType: row.sourceType,
				lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
				lastError: row.lastError,
				metadata: row.metadata ?? null,
			})),
		});
	} catch (error) {
		console.error("[mcp-chat/servers/status] Error:", error);
		return NextResponse.json(
			{ error: "Failed to list server status" },
			{ status: 500 },
		);
	}
}
