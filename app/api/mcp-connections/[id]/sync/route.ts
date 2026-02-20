import { NextResponse } from "next/server";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { getSession } from "@/lib/auth-helpers";
import {
	getPopulatedMcpServerByProjectId,
	syncHostedWorkflowMcpConnection,
} from "@/lib/db/mcp";
import {
	getMcpConnectionById,
	updateMcpConnectionSync,
} from "@/lib/db/mcp-connections";
import { toMcpConnectionDto } from "@/lib/mcp-connections/serialize";
import { ensurePieceServer } from "@/lib/mcp-runtime/service";
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

	if (row.sourceType === "hosted_workflow") {
		const server = await getPopulatedMcpServerByProjectId(
			session.user.projectId,
		);
		const synced = await syncHostedWorkflowMcpConnection({
			projectId: session.user.projectId,
			status: server.status,
			actorUserId: session.user.id,
			request,
		});

		// Derive tool list from the hosted MCP workflows
		const hostedTools = server.flows
			.filter((f) => f.enabled)
			.map((f) => ({
				name: f.trigger.toolName,
				description: f.trigger.toolDescription || undefined,
			}));
		if (hostedTools.length > 0 || synced.metadata) {
			const existingMeta = (synced.metadata as Record<string, unknown>) ?? {};
			const updated = await updateMcpConnectionSync({
				id,
				projectId: session.user.projectId,
				status: synced.status as "ENABLED" | "DISABLED" | "ERROR",
				lastError: synced.lastError,
				metadata: {
					...existingMeta,
					toolCount: hostedTools.length,
					tools: hostedTools,
				},
				actorUserId: session.user.id,
			});
			if (updated) {
				return NextResponse.json(toMcpConnectionDto(updated));
			}
		}

		return NextResponse.json(toMcpConnectionDto(synced));
	}

	if (row.sourceType === "nimble_piece") {
		const pieceName = normalizePieceName(row.pieceName ?? "");
		if (!pieceName) {
			return NextResponse.json(
				{ error: "Piece name is required for nimble_piece rows" },
				{ status: 400 },
			);
		}
		const runtime = await ensurePieceServer({
			pieceName,
		});
		const serverUrl = runtime.server?.url ?? row.serverUrl;

		// Discover tools from the running server
		let toolsMeta: { toolCount: number; tools: { name: string; description?: string }[] } = { toolCount: 0, tools: [] };
		if (serverUrl && runtime.server?.healthy) {
			try {
				const discovered = await discoverTools(serverUrl, row.displayName, session.user.id);
				toolsMeta = {
					toolCount: discovered.length,
					tools: discovered.map((t) => ({ name: t.name, description: t.description })),
				};
			} catch {
				// Tool discovery failed — still update runtime info
			}
		}

		const updated = await updateMcpConnectionSync({
			id,
			projectId: session.user.projectId,
			serverUrl,
			registryRef: runtime.server?.registryRef ?? row.registryRef,
			status: runtime.server?.healthy
				? "ENABLED"
				: row.status === "DISABLED"
					? "DISABLED"
					: "ERROR",
			lastError: runtime.server?.healthy
				? null
				: (runtime.error ?? "Runtime server unavailable"),
			metadata: runtime.server
				? {
						provider: runtime.server.provider,
						serviceName: runtime.server.serviceName,
						...toolsMeta,
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
					tools: tools.map((t) => ({ name: t.name, description: t.description })),
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
