import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	registerAppTool,
	registerAppResource,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { WEATHER_DASHBOARD_HTML } from "./html-content";
import { METRIC_DASHBOARD_HTML } from "./tools/metric-dashboard-html";
import { COLOR_PALETTE_HTML } from "./tools/color-palette-html";
import { CODE_VIEWER_HTML } from "./tools/code-viewer-html";

const WEATHER_RESOURCE_URI =
	"ui://weather-server/dashboard-template" as const;
const METRIC_RESOURCE_URI = "ui://mcp-apps/metric-dashboard" as const;
const COLOR_RESOURCE_URI = "ui://mcp-apps/color-palette" as const;
const CODE_RESOURCE_URI = "ui://mcp-apps/code-viewer" as const;

/**
 * Creates a configured MCP server with demo tools and their UI resources.
 */
export function createMcpAppsServer(): McpServer {
	const server = new McpServer({
		name: "mcp-apps-demo",
		version: "1.0.0",
	});

	// --- Weather Dashboard ---
	registerAppResource(
		server,
		"weather_dashboard_ui",
		WEATHER_RESOURCE_URI,
		{} as Parameters<typeof registerAppResource>[3],
		async () => ({
			contents: [
				{
					uri: WEATHER_RESOURCE_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: WEATHER_DASHBOARD_HTML,
				},
			],
		}),
	);

	registerAppTool(
		server,
		"weather_dashboard",
		{
			description: "Interactive weather dashboard widget",
			inputSchema: {
				location: z.string().describe("City name"),
			},
			_meta: { ui: { resourceUri: WEATHER_RESOURCE_URI } },
		},
		async ({ location }) => ({
			content: [
				{
					type: "text" as const,
					text: `Weather dashboard for ${location}`,
				},
			],
		}),
	);

	// --- Metric Dashboard ---
	registerAppResource(
		server,
		"metric_dashboard_ui",
		METRIC_RESOURCE_URI,
		{} as Parameters<typeof registerAppResource>[3],
		async () => ({
			contents: [
				{
					uri: METRIC_RESOURCE_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: METRIC_DASHBOARD_HTML,
				},
			],
		}),
	);

	registerAppTool(
		server,
		"metric_dashboard",
		{
			description:
				"Interactive KPI/metrics dashboard with sparkline charts and trend indicators",
			inputSchema: {
				title: z.string().describe("Dashboard title"),
				metrics: z
					.array(
						z.object({
							name: z.string().describe("Metric name"),
							value: z.number().describe("Current metric value"),
							change: z
								.number()
								.describe("Percentage change (positive=up, negative=down)"),
							unit: z.string().describe("Unit label (e.g. 'users', '$', 'ms')"),
						}),
					)
					.describe("Array of metrics to display"),
			},
			_meta: { ui: { resourceUri: METRIC_RESOURCE_URI } },
		},
		async ({ title, metrics }) => {
			const metricsList = metrics as Array<{ name: string }>;
			return {
				content: [
					{
						type: "text" as const,
						text: `Metric dashboard "${title}" with ${metricsList.length} metrics: ${metricsList.map((m) => m.name).join(", ")}`,
					},
				],
			};
		},
	);

	// --- Color Palette ---
	registerAppResource(
		server,
		"color_palette_ui",
		COLOR_RESOURCE_URI,
		{} as Parameters<typeof registerAppResource>[3],
		async () => ({
			contents: [
				{
					uri: COLOR_RESOURCE_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: COLOR_PALETTE_HTML,
				},
			],
		}),
	);

	registerAppTool(
		server,
		"color_palette",
		{
			description:
				"Generate and display an interactive color palette from a base color",
			inputSchema: {
				baseColor: z.string().describe("Base color as hex (e.g. '#3B82F6')"),
				paletteType: z
					.string()
					.optional()
					.describe(
						"Palette type: complementary, analogous, triadic, or split-complementary",
					),
			},
			_meta: { ui: { resourceUri: COLOR_RESOURCE_URI } },
		},
		async ({ baseColor, paletteType }) => ({
			content: [
				{
					type: "text" as const,
					text: `Color palette generated from ${baseColor}${paletteType ? ` (${paletteType})` : ""}`,
				},
			],
		}),
	);

	// --- Code Viewer ---
	registerAppResource(
		server,
		"code_viewer_ui",
		CODE_RESOURCE_URI,
		{} as Parameters<typeof registerAppResource>[3],
		async () => ({
			contents: [
				{
					uri: CODE_RESOURCE_URI,
					mimeType: RESOURCE_MIME_TYPE,
					text: CODE_VIEWER_HTML,
				},
			],
		}),
	);

	registerAppTool(
		server,
		"code_viewer",
		{
			description: "Display code with syntax highlighting in an interactive viewer",
			inputSchema: {
				code: z.string().describe("The code to display"),
				language: z
					.string()
					.describe(
						"Programming language (e.g. 'javascript', 'python', 'typescript')",
					),
				title: z.string().optional().describe("Optional title for the code block"),
			},
			_meta: { ui: { resourceUri: CODE_RESOURCE_URI } },
		},
		async ({ code, language, title }) => ({
			content: [
				{
					type: "text" as const,
					text: `Code viewer: ${title || language} (${String(code).split("\n").length} lines)`,
				},
			],
		}),
	);

	return server;
}
