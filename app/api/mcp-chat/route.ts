import {
	streamText,
	stepCountIs,
	convertToModelMessages,
	jsonSchema,
	tool,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { getMcpChatTools } from "@/lib/mcp-chat/tools";
import {
	discoverTools,
	callExternalMcpTool,
} from "@/lib/mcp-chat/mcp-client-manager";
import { getSecretValueAsync } from "@/lib/dapr/config-provider";
import { NextResponse } from "next/server";

async function getModel() {
	const gatewayBaseURL = process.env.AI_GATEWAY_BASE_URL;

	// Try Dapr secrets first, then fall back to environment variables
	const openaiKey =
		(await getSecretValueAsync("OPENAI_API_KEY")) || process.env.OPENAI_API_KEY;
	const gatewayKey =
		(await getSecretValueAsync("AI_GATEWAY_API_KEY")) ||
		process.env.AI_GATEWAY_API_KEY;

	const apiKey = gatewayBaseURL
		? (gatewayKey ?? openaiKey)
		: (openaiKey ?? gatewayKey);

	if (!apiKey) {
		throw new Error(
			"Missing AI API key (set OPENAI_API_KEY or AI_GATEWAY_API_KEY).",
		);
	}

	const modelId =
		process.env.AI_MODEL ?? (gatewayBaseURL ? "openai/gpt-4o" : "gpt-4o");

	const provider = createOpenAI({
		apiKey,
		...(gatewayBaseURL ? { baseURL: gatewayBaseURL } : {}),
	});

	return provider.chat(modelId);
}

const BUILTIN_SYSTEM_PROMPT = `You are a helpful assistant with access to interactive MCP tools that render rich widgets inline in the chat.

Available built-in tools:
- **weather_dashboard**: Show an interactive weather dashboard for any city. Use when asked about weather.
- **metric_dashboard**: Show a KPI/metrics dashboard with sparkline charts. Use when asked about metrics, stats, or analytics. You can create realistic sample data.
- **color_palette**: Generate interactive color palettes from a base color. Use when asked about colors or design.
- **code_viewer**: Display code with syntax highlighting. Use when asked to show, write, or display code.

Guidelines:
- Use tools proactively when they'd enhance the response. For example, if asked to write code, use code_viewer to display it nicely.
- When creating metric dashboards, generate realistic sample data with varied positive/negative changes.
- For color palettes, suggest complementary, analogous, or triadic types as appropriate.
- Always provide a brief text explanation alongside tool results.
- You can use multiple tools in a single response if appropriate.`;

type McpServerEntry = { url: string; name: string };

/**
 * Recursively fix JSON Schema objects that have `type: "array"` but no `items`.
 * OpenAI rejects such schemas. We default missing items to `{}` (any).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeSchema(schema: any): any {
	if (schema == null || typeof schema !== "object") return schema;

	if (Array.isArray(schema)) {
		return schema.map(sanitizeSchema);
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const out: any = {};
	for (const [key, value] of Object.entries(schema)) {
		out[key] = sanitizeSchema(value);
	}

	if (out.type === "array" && !out.items) {
		out.items = {};
	}

	return out;
}

export async function POST(req: Request) {
	try {
		const { messages: uiMessages, mcpServers } = await req.json();

		// Discover external tools in parallel
		const externalServers: McpServerEntry[] = mcpServers ?? [];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const externalTools: Record<string, any> = {};
		const externalDescriptions: string[] = [];

		if (externalServers.length > 0) {
			const results = await Promise.allSettled(
				externalServers.map(async (server: McpServerEntry) => {
					const tools = await discoverTools(server.url, server.name);
					return { server, tools };
				}),
			);

			for (const result of results) {
				if (result.status !== "fulfilled") continue;
				const { server, tools } = result.value;

				for (const mcpTool of tools) {
					const namespacedName = `${server.name.replace(/\s+/g, "_")}__${mcpTool.name}`;

					externalTools[namespacedName] = tool({
						description: `[${server.name}] ${mcpTool.description ?? mcpTool.name}`,
						inputSchema: jsonSchema(
							sanitizeSchema(mcpTool.inputSchema) as Record<string, unknown>,
						),
						execute: async (args) =>
							callExternalMcpTool(
								server.url,
								mcpTool.name,
								args as Record<string, unknown>,
							),
					});

					externalDescriptions.push(
						`- **${namespacedName}**: [${server.name}] ${mcpTool.description ?? mcpTool.name}`,
					);
				}
			}
		}

		// Build dynamic system prompt
		let systemPrompt = BUILTIN_SYSTEM_PROMPT;
		if (externalDescriptions.length > 0) {
			systemPrompt += `\n\nExternal MCP server tools:\n${externalDescriptions.join("\n")}`;
		}

		// Merge tools
		const allTools = {
			...getMcpChatTools(),
			...externalTools,
		};

		// Convert UIMessage[] (parts format) to ModelMessage[] (content format)
		const modelMessages = await convertToModelMessages(uiMessages);

		const result = streamText({
			model: await getModel(),
			system: systemPrompt,
			messages: modelMessages,
			tools: allTools,
			stopWhen: stepCountIs(3),
		});

		return result.toUIMessageStreamResponse();
	} catch (error) {
		console.error("[mcp-chat] API error:", error);
		return NextResponse.json(
			{
				error: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}
