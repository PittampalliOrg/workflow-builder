import { NextResponse } from "next/server";
import { getMcpRun } from "@/lib/db/mcp";
import { isValidInternalToken } from "@/lib/internal-api";

type RouteParams = { params: Promise<{ runId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  if (!isValidInternalToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { runId } = await params;
  const run = await getMcpRun(runId);
  if (!run) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(run);
}
