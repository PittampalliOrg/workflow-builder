import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { listMcpConnections } from "@/lib/db/mcp-connections";
import { getUserProjectRole } from "@/lib/project-service";

type DiscoveredServer = {
	id: string;
	name: string;
	pieceName: string;
	url: string;
	healthy: boolean;
	enabled: boolean;
	toolCount: number;
	toolNames: string[];
	status: string;
};

/**
 * GET /api/mcp-chat/servers/discover
 *
 * Returns project-managed MCP connections that are enabled
 * and have a usable server URL.
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

		const servers: DiscoveredServer[] = rows.map((row) => {
			const metadata = (row.metadata ?? {}) as {
				toolCount?: number;
				toolNames?: string[];
			};
			return {
				id: row.id,
				name: row.displayName,
				pieceName: row.pieceName ?? row.displayName,
				url: row.serverUrl ?? "",
				healthy: row.status !== "ERROR",
				enabled: row.status === "ENABLED",
				toolCount: metadata.toolCount ?? 0,
				toolNames: metadata.toolNames ?? [],
				status: row.status,
			};
		});

		return NextResponse.json({ servers });
	} catch (error) {
		console.error("[mcp-chat/servers/discover] Error:", error);
		return NextResponse.json(
			{ error: "Failed to discover servers" },
			{ status: 500 },
		);
	}
}
