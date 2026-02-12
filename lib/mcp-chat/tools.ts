import { tool } from "ai";
import { z } from "zod";
import { createMcpAppsServer } from "@/lib/mcp-apps/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

type McpToolResult = {
	text: string;
	uiHtml: string | null;
	toolName: string;
};

/**
 * Call an MCP tool on the local server, return text result + UI HTML.
 */
async function callMcpTool(
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpToolResult> {
	const server = createMcpAppsServer();
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();

	const client = new Client({ name: "mcp-chat", version: "1.0.0" });

	await server.connect(serverTransport);
	await client.connect(clientTransport);

	try {
		// Call the tool
		const toolResult = await client.callTool({
			name: toolName,
			arguments: args,
		});

		// Get UI resource URI from tool metadata
		const toolsList = await client.listTools();
		const toolDef = toolsList.tools.find((t) => t.name === toolName);
		let uiHtml: string | null = null;

		const meta = toolDef?._meta as
			| { ui?: { resourceUri?: string } }
			| undefined;
		const resourceUri = meta?.ui?.resourceUri;

		if (resourceUri) {
			const resourceResult = await client.readResource({ uri: resourceUri });
			const content = resourceResult.contents[0];
			if (content && "text" in content) {
				uiHtml = content.text;
			}
		}

		// Extract text from tool result
		const textContent =
			(
				toolResult.content as Array<{
					type: string;
					text?: string;
				}>
			)?.find((c) => c.type === "text")?.text ?? "";

		return { text: textContent, uiHtml, toolName };
	} finally {
		await client.close();
		await server.close();
	}
}

/**
 * Returns Vercel AI SDK tool definitions that call the MCP server tools.
 */
export function getMcpChatTools() {
	return {
		weather_dashboard: tool({
			description:
				"Show an interactive weather dashboard widget for a city. Use when the user asks about weather.",
			inputSchema: z.object({
				location: z.string().describe("City name"),
			}),
			execute: async ({ location }) => {
				return callMcpTool("weather_dashboard", { location });
			},
		}),

		metric_dashboard: tool({
			description:
				"Show an interactive KPI/metrics dashboard with sparkline charts. Use when the user wants to see metrics, statistics, KPIs, or analytics data.",
			inputSchema: z.object({
				title: z.string().describe("Dashboard title"),
				metrics: z
					.array(
						z.object({
							name: z.string().describe("Metric name"),
							value: z.number().describe("Metric value"),
							change: z
								.number()
								.describe(
									"Percentage change (positive for up, negative for down)",
								),
							unit: z
								.string()
								.describe("Unit label (e.g. 'users', '$', 'ms')"),
						}),
					)
					.describe("Array of metrics to display"),
			}),
			execute: async ({ title, metrics }) => {
				return callMcpTool("metric_dashboard", { title, metrics });
			},
		}),

		color_palette: tool({
			description:
				"Generate and display an interactive color palette. Use when the user asks about colors, palettes, or design.",
			inputSchema: z.object({
				baseColor: z
					.string()
					.describe("Base color as hex (e.g. '#3B82F6')"),
				paletteType: z
					.string()
					.optional()
					.describe(
						"Palette type: complementary, analogous, triadic, or split-complementary",
					),
			}),
			execute: async ({ baseColor, paletteType }) => {
				return callMcpTool("color_palette", { baseColor, paletteType });
			},
		}),

		code_viewer: tool({
			description:
				"Display code with syntax highlighting in an interactive viewer. Use when the user shares code or asks to see code.",
			inputSchema: z.object({
				code: z.string().describe("The code to display"),
				language: z
					.string()
					.describe(
						"Programming language (e.g. 'javascript', 'python', 'typescript')",
					),
				title: z
					.string()
					.optional()
					.describe("Optional title for the code block"),
			}),
			execute: async ({ code, language, title }) => {
				return callMcpTool("code_viewer", { code, language, title });
			},
		}),
	};
}
