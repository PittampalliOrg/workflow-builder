import { NextResponse } from "next/server";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { getSession } from "@/lib/auth-helpers";
import {
	getPopulatedMcpServerByProjectId,
	syncHostedWorkflowMcpConnection,
} from "@/lib/db/mcp";
import {
	createCustomMcpConnection,
	listMcpConnections,
	upsertPieceMcpConnection,
} from "@/lib/db/mcp-connections";
import { getLatestPieceMetadataByName } from "@/lib/db/piece-metadata";
import { toMcpConnectionDto } from "@/lib/mcp-connections/serialize";
import { ensurePieceServer } from "@/lib/mcp-runtime/service";
import { getUserProjectRole } from "@/lib/project-service";
import {
	type CreateMcpConnectionBody,
	McpConnectionSourceType,
	type McpConnectionStatus,
} from "@/lib/types/mcp-connection";

function canWrite(role: string) {
	return role === "ADMIN" || role === "EDITOR";
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { searchParams } = new URL(request.url);
		const projectId = searchParams.get("projectId") ?? session.user.projectId;
		const status = searchParams.get("status") as McpConnectionStatus | null;
		const role = await getUserProjectRole(session.user.id, projectId);
		if (!role) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		const hosted = await getPopulatedMcpServerByProjectId(projectId);
		await syncHostedWorkflowMcpConnection({
			projectId,
			status: hosted.status,
			actorUserId: session.user.id,
			request,
		});

		const rows = await listMcpConnections({
			projectId,
			status: status ?? undefined,
		});

		return NextResponse.json({
			data: rows.map(toMcpConnectionDto),
		});
	} catch (error) {
		console.error("[mcp-connections GET] Error:", error);
		return NextResponse.json(
			{ error: "Failed to list MCP connections" },
			{ status: 500 },
		);
	}
}

export async function POST(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const body = (await request.json()) as CreateMcpConnectionBody;
		const projectId = session.user.projectId;
		const role = await getUserProjectRole(session.user.id, projectId);
		if (!(role && canWrite(role))) {
			return NextResponse.json({ error: "Forbidden" }, { status: 403 });
		}

		if (body.sourceType === McpConnectionSourceType.NIMBLE_PIECE) {
			const pieceName = normalizePieceName(body.pieceName);
			const piece = await getLatestPieceMetadataByName(pieceName);
			const displayName = body.displayName ?? piece?.displayName ?? pieceName;

			const ensured = await ensurePieceServer({
				pieceName,
			});
			const status: McpConnectionStatus = ensured.server?.healthy
				? "ENABLED"
				: "ERROR";

			const row = await upsertPieceMcpConnection({
				projectId,
				pieceName,
				displayName,
				status,
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

			return NextResponse.json(toMcpConnectionDto(row), { status: 201 });
		}

		if (body.sourceType === McpConnectionSourceType.CUSTOM_URL) {
			if (!body.serverUrl || !body.displayName) {
				return NextResponse.json(
					{ error: "displayName and serverUrl are required" },
					{ status: 400 },
				);
			}

			const row = await createCustomMcpConnection({
				projectId,
				displayName: body.displayName,
				serverUrl: body.serverUrl,
				status: "ENABLED",
				actorUserId: session.user.id,
			});
			return NextResponse.json(toMcpConnectionDto(row), { status: 201 });
		}

		return NextResponse.json(
			{ error: "Unsupported sourceType" },
			{ status: 400 },
		);
	} catch (error) {
		console.error("[mcp-connections POST] Error:", error);
		return NextResponse.json(
			{ error: "Failed to create MCP connection" },
			{ status: 500 },
		);
	}
}
