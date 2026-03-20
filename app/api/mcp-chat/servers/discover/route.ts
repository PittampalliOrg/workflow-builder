import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { listMcpConnections } from "@/lib/db/mcp-connections";
import { getUserProjectRole } from "@/lib/project-service";

type DiscoveredServer = {
	id: string;
	name: string;
	sourceType: string;
	catalogKey: string;
	pieceName: string;
	serverKey: string | null;
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
 * Legacy endpoint for MCP Chat server discovery.
 * Prefer /api/mcp-connections for managed-connection state.
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
				tools?: Array<{ name?: string }>;
				toolNames?: string[];
			};
			const toolNames = Array.isArray(metadata.tools)
				? metadata.tools
						.map((tool) => tool?.name)
						.filter((name): name is string => typeof name === "string")
				: (metadata.toolNames ?? []);
			const catalogKey =
				row.sourceType === "nimble_shared"
					? (row.serverKey ?? row.displayName)
					: (row.pieceName ?? row.displayName);
			return {
				id: row.id,
				name: row.displayName,
				sourceType: row.sourceType,
				catalogKey,
				pieceName: row.pieceName ?? row.displayName,
				serverKey: row.serverKey,
				url: row.serverUrl ?? "",
				healthy: row.status !== "ERROR",
				enabled: row.status === "ENABLED",
				toolCount: metadata.toolCount ?? 0,
				toolNames,
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
