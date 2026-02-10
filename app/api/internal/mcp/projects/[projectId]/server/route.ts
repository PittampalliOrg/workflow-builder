import { NextResponse } from "next/server";
import { getPopulatedMcpServerByProjectId } from "@/lib/db/mcp";
import { isValidInternalToken } from "@/lib/internal-api";

type RouteParams = { params: Promise<{ projectId: string }> };

/**
 * Internal: Used by mcp-gateway to fetch decrypted token + MCP tool definitions.
 */
export async function GET(request: Request, { params }: RouteParams) {
  if (!isValidInternalToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { projectId } = await params;
  const server = await getPopulatedMcpServerByProjectId(projectId);
  return NextResponse.json(server);
}
