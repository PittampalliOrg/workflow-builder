import { NextResponse } from "next/server";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { getSession } from "@/lib/auth-helpers";
import {
	syncHostedWorkflowMcpConnection,
	updateMcpServerStatus,
} from "@/lib/db/mcp";
import {
	getMcpConnectionById,
	updateMcpConnectionStatus,
	updateMcpConnectionSync,
} from "@/lib/db/mcp-connections";
import { toMcpConnectionDto } from "@/lib/mcp-connections/serialize";
import { ensurePieceServer } from "@/lib/mcp-runtime/service";
import { getUserProjectRole } from "@/lib/project-service";
import type { McpConnectionStatus } from "@/lib/types/mcp-connection";

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
	const body = (await request.json()) as { status?: McpConnectionStatus };
	if (!(body.status === "ENABLED" || body.status === "DISABLED")) {
		return NextResponse.json({ error: "Invalid status" }, { status: 400 });
	}

	const current = await getMcpConnectionById({
		id,
		projectId: session.user.projectId,
	});
	if (!current) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	if (current.sourceType === "hosted_workflow") {
		const server = await updateMcpServerStatus({
			projectId: session.user.projectId,
			status: body.status,
		});
		const synced = await syncHostedWorkflowMcpConnection({
			projectId: session.user.projectId,
			status: server.status,
			actorUserId: session.user.id,
			request,
		});
		return NextResponse.json(toMcpConnectionDto(synced));
	}

	if (body.status === "DISABLED") {
		const row = await updateMcpConnectionStatus({
			id,
			projectId: session.user.projectId,
			status: "DISABLED",
			actorUserId: session.user.id,
			lastError: null,
		});
		return NextResponse.json(row ? toMcpConnectionDto(row) : null);
	}

	if (current.sourceType === "nimble_piece") {
		const pieceName = normalizePieceName(current.pieceName ?? "");
		if (!pieceName) {
			return NextResponse.json(
				{ error: "Piece name is required for nimble_piece rows" },
				{ status: 400 },
			);
		}

		const ensured = await ensurePieceServer({
			pieceName,
		});
		const synced = await updateMcpConnectionSync({
			id,
			projectId: session.user.projectId,
			serverUrl: ensured.server?.url ?? current.serverUrl,
			registryRef: ensured.server?.registryRef ?? current.registryRef,
			status: ensured.server?.healthy ? "ENABLED" : "ERROR",
			lastError: ensured.server?.healthy
				? null
				: (ensured.error ?? "Server unavailable"),
			metadata: ensured.server
				? {
						provider: ensured.server.provider,
						serviceName: ensured.server.serviceName,
					}
				: (current.metadata as Record<string, unknown> | null),
			actorUserId: session.user.id,
		});
		return NextResponse.json(synced ? toMcpConnectionDto(synced) : null);
	}

	const row = await updateMcpConnectionStatus({
		id,
		projectId: session.user.projectId,
		status: "ENABLED",
		actorUserId: session.user.id,
		lastError: null,
	});
	return NextResponse.json(row ? toMcpConnectionDto(row) : null);
}
