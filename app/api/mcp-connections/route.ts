import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { normalizePieceName } from "@/lib/activepieces/installed-pieces";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
	createCustomMcpConnection,
	listMcpConnections,
	upsertPieceMcpConnection,
} from "@/lib/db/mcp-connections";
import { getLatestPieceMetadataByName } from "@/lib/db/piece-metadata";
import { appConnections } from "@/lib/db/schema";
import { toMcpConnectionDto } from "@/lib/mcp-connections/serialize";
import { ensurePieceServer } from "@/lib/mcp-runtime/service";
import { getUserProjectRole } from "@/lib/project-service";
import { AppConnectionStatus } from "@/lib/types/app-connection";
import {
	type CreateMcpConnectionBody,
	McpConnectionSourceType,
	type McpConnectionStatus,
} from "@/lib/types/mcp-connection";

function canWrite(role: string) {
	return role === "ADMIN" || role === "EDITOR";
}

function candidatesForPieceName(pieceName: string): string[] {
	const normalized = normalizePieceName(pieceName);
	return [normalized, `@activepieces/piece-${normalized}`];
}

export async function GET(request: Request) {
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

	const rows = await listMcpConnections({
		projectId,
		status: status ?? undefined,
	});

	return NextResponse.json({
		data: rows.map(toMcpConnectionDto),
	});
}

export async function POST(request: Request) {
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

		const activeConnection = await db
			.select({ externalId: appConnections.externalId })
			.from(appConnections)
			.where(
				and(
					eq(appConnections.status, AppConnectionStatus.ACTIVE),
					inArray(appConnections.pieceName, candidatesForPieceName(pieceName)),
				),
			)
			.limit(1);

		const ensured = await ensurePieceServer({
			pieceName,
			connectionExternalId: activeConnection[0]?.externalId,
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
}
