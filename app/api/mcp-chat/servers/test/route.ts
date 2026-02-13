import { NextResponse } from "next/server";
import { discoverTools } from "@/lib/mcp-chat/mcp-client-manager";

export async function POST(req: Request) {
	try {
		const { url } = await req.json();

		if (!url || typeof url !== "string") {
			return NextResponse.json(
				{ error: "Missing or invalid 'url' field" },
				{ status: 400 },
			);
		}

		const tools = await discoverTools(url, "test");

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
