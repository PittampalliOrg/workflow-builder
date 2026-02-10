import { NextResponse } from "next/server";
import { respondToMcpRun } from "@/lib/db/mcp";
import { isValidInternalToken } from "@/lib/internal-api";

type RouteParams = { params: Promise<{ runId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  if (!isValidInternalToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  const body = await request.json().catch(() => ({}));

  const updated = await respondToMcpRun({ runId, response: body?.response });
  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
