import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { discoverTools } from "@/lib/mcp-chat/mcp-client-manager";

export async function POST(req: Request) {
	try {
		const session = await getSession(req);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { url } = await req.json();

		if (!url || typeof url !== "string") {
			return NextResponse.json(
				{ error: "Missing or invalid 'url' field" },
				{ status: 400 },
			);
		}

		const tools = await discoverTools(url, "test", session.user.id);

		return NextResponse.json({
			tools: tools.map(({ name, description }) => ({ name, description })),
		});
	} catch (error) {
		console.error("[mcp-chat/servers/test] Error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to connect to MCP server",
			},
			{ status: 500 },
		);
	}
}
