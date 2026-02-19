import { NextResponse } from "next/server";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { getSession } from "@/lib/auth-helpers";
import {
	getMcpConnectionById,
	updateMcpConnectionSync,
} from "@/lib/db/mcp-connections";
import { toMcpConnectionDto } from "@/lib/mcp-connections/serialize";
import { discoverPieceServer } from "@/lib/mcp-runtime/service";
import { getUserProjectRole } from "@/lib/project-service";
import { discoverTools } from "@/lib/mcp-chat/mcp-client-manager";

function canWrite(role: string) {
	return role === "ADMIN" || role === "EDITOR";
}

export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> },
) {
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

	const { id } = await params;
	const row = await getMcpConnectionById({
		id,
		projectId: session.user.projectId,
	});
	if (!row) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	if (row.sourceType === "nimble_piece") {
		const pieceName = normalizePieceName(row.pieceName ?? "");
		const runtime = await discoverPieceServer(pieceName);
		const updated = await updateMcpConnectionSync({
			id,
			projectId: session.user.projectId,
			serverUrl: runtime?.url ?? row.serverUrl,
			registryRef: runtime?.registryRef ?? row.registryRef,
			status: runtime?.healthy
				? "ENABLED"
				: row.status === "DISABLED"
					? "DISABLED"
					: "ERROR",
			lastError: runtime?.healthy ? null : "Runtime server unavailable",
			metadata: runtime
				? {
						provider: runtime.provider,
						serviceName: runtime.serviceName,
					}
				: (row.metadata as Record<string, unknown> | null),
			actorUserId: session.user.id,
		});
		return NextResponse.json(updated ? toMcpConnectionDto(updated) : null);
	}

	if (row.serverUrl) {
		try {
			const tools = await discoverTools(
				row.serverUrl,
				row.displayName,
				session.user.id,
			);
			const updated = await updateMcpConnectionSync({
				id,
				projectId: session.user.projectId,
				status: row.status === "DISABLED" ? "DISABLED" : "ENABLED",
				lastError: null,
				metadata: {
					...(row.metadata as Record<string, unknown> | null),
					toolCount: tools.length,
				},
				actorUserId: session.user.id,
			});
			return NextResponse.json(updated ? toMcpConnectionDto(updated) : null);
		} catch (error) {
			const updated = await updateMcpConnectionSync({
				id,
				projectId: session.user.projectId,
				status: row.status === "DISABLED" ? "DISABLED" : "ERROR",
				lastError: error instanceof Error ? error.message : "Sync failed",
				actorUserId: session.user.id,
			});
			return NextResponse.json(updated ? toMcpConnectionDto(updated) : null);
		}
	}

	return NextResponse.json(toMcpConnectionDto(row));
}
