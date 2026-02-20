import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import {
	getPopulatedMcpServerByProjectId,
	syncHostedWorkflowMcpConnection,
	updateMcpServerStatus,
} from "@/lib/db/mcp";
import { getUserProjectRole } from "@/lib/project-service";

type RouteParams = { params: Promise<{ projectId: string }> };

function canWriteMcp(role: string) {
	return role === "ADMIN" || role === "EDITOR";
}

export async function GET(request: Request, { params }: RouteParams) {
	const session = await getSession(request);
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { projectId } = await params;
	const role = await getUserProjectRole(session.user.id, projectId);
	if (!role) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const mcpServer = await getPopulatedMcpServerByProjectId(projectId);
	await syncHostedWorkflowMcpConnection({
		projectId,
		status: mcpServer.status,
		actorUserId: session.user.id,
		request,
	});
	return NextResponse.json(mcpServer);
}

export async function POST(request: Request, { params }: RouteParams) {
	const session = await getSession(request);
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { projectId } = await params;
	const role = await getUserProjectRole(session.user.id, projectId);
	if (!(role && canWriteMcp(role))) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const body = (await request.json().catch(() => null)) as {
		status?: "ENABLED" | "DISABLED";
	} | null;

	if (
		!body?.status ||
		(body.status !== "ENABLED" && body.status !== "DISABLED")
	) {
		return NextResponse.json({ error: "Invalid status" }, { status: 400 });
	}

	const updated = await updateMcpServerStatus({
		projectId,
		status: body.status,
	});
	await syncHostedWorkflowMcpConnection({
		projectId,
		status: updated.status,
		actorUserId: session.user.id,
		request,
	});
	return NextResponse.json(updated);
}
