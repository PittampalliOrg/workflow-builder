import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { rotateMcpServerToken } from "@/lib/db/mcp";
import { getUserProjectRole } from "@/lib/project-service";

type RouteParams = { params: Promise<{ projectId: string }> };

function canWriteMcp(role: string) {
  return role === "ADMIN" || role === "EDITOR";
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

  const updated = await rotateMcpServerToken({ projectId });
  return NextResponse.json(updated);
}
