import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { getMcpConnectionCatalog } from "@/lib/mcp-connections/catalog";
import { getUserProjectRole } from "@/lib/project-service";

export async function GET(request: Request) {
	const session = await getSession(request);
	if (!session?.user) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { searchParams } = new URL(request.url);
	const projectId = searchParams.get("projectId") ?? session.user.projectId;
	const role = await getUserProjectRole(session.user.id, projectId);
	if (!role) {
		return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	}

	const data = await getMcpConnectionCatalog(projectId);
	return NextResponse.json({ data });
}
