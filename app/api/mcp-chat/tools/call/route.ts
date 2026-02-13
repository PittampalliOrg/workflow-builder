import { callExternalMcpToolDirect } from "@/lib/mcp-chat/mcp-client-manager";

export async function POST(req: Request) {
  try {
    const { serverUrl, toolName, arguments: args } = await req.json();

    if (!serverUrl || !toolName) {
      return Response.json(
        { error: "serverUrl and toolName are required" },
        { status: 400 },
      );
    }

    const result = await callExternalMcpToolDirect(
      serverUrl,
      toolName,
      args ?? {},
    );
    return Response.json(result);
  } catch (error) {
    console.error("[mcp-chat/tools/call] Error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
