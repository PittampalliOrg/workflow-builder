/**
 * MCP Server Factory
 *
 * Creates a configured McpServer with 4 tools + UI resource.
 * Adapted from mastra-agent-mcp/src/agent-tools.ts to load UI from dist-ui/.
 */

import fs from "node:fs";
import path from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	registerAppResource,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { eventBus } from "./event-bus";
import { runAgent } from "./agent";

function textResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(msg: string) {
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true,
	};
}

// Resolve UI HTML path — try multiple locations
function resolveUiHtml(): string | null {
	const candidates = [
		path.join(process.cwd(), "dist-ui", "agent-monitor", "index.html"),
		path.join(process.cwd(), "dist-ui", "index.html"),
	];

	for (const p of candidates) {
		if (fs.existsSync(p)) {
			return p;
		}
	}
	return null;
}

/**
 * Create a fully configured MCP server instance.
 * Returns the low-level Server (not McpServer) for use with transports.
 */
export function createMcpServer(): Server {
	const mcpServer = new McpServer(
		{ name: "mastra-agent-tanstack", version: "1.0.0" },
		{ capabilities: { tools: {}, resources: {} } },
	);

	const uiHtmlPath = resolveUiHtml();

	const uiMeta: Record<string, unknown> = {};

	if (uiHtmlPath) {
		const htmlContent = fs.readFileSync(uiHtmlPath, "utf-8");
		const resourceUri = "ui://mastra-agent-tanstack/app.html";

		registerAppResource(
			mcpServer,
			"Mastra Agent Monitor UI",
			resourceUri,
			{ mimeType: RESOURCE_MIME_TYPE },
			async () => ({
				contents: [
					{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: htmlContent },
				],
			}),
		);

		uiMeta.ui = { resourceUri };
		uiMeta["ui/resourceUri"] = resourceUri;
		console.log(`[mastra-tanstack] UI resource loaded from: ${uiHtmlPath}`);
	} else {
		console.warn(
			"[mastra-tanstack] UI HTML not found — tools will work without interactive UI",
		);
	}

	// ── get_agent_status ───────────────────────────────
	mcpServer.registerTool(
		"get_agent_status",
		{
			title: "Get Agent Status",
			description:
				"Get the current Mastra agent status including run state, metrics, and available tools.",
			inputSchema: {},
			_meta: uiMeta,
		},
		async () => {
			try {
				return textResult(eventBus.getState());
			} catch (err) {
				return errorResult(`Failed to get agent status: ${err}`);
			}
		},
	);

	// ── run_agent ──────────────────────────────────────
	mcpServer.registerTool(
		"run_agent",
		{
			title: "Run Agent",
			description:
				"Run the Mastra agent with a prompt. Returns the agent's text response, tool calls made, and token usage.",
			inputSchema: {
				prompt: z.string().describe("The prompt to send to the agent"),
			},
			_meta: uiMeta,
		},
		async (args: { prompt: string }) => {
			try {
				const result = await runAgent(args.prompt);
				return textResult(result);
			} catch (err) {
				return errorResult(`Agent run failed: ${err}`);
			}
		},
	);

	// ── get_workflow_context ───────────────────────────
	mcpServer.registerTool(
		"get_workflow_context",
		{
			title: "Get Workflow Context",
			description:
				"Get the current Dapr workflow context (workflow ID, node position, received events).",
			inputSchema: {},
			_meta: uiMeta,
		},
		async () => {
			try {
				return textResult(eventBus.getWorkflowContext());
			} catch (err) {
				return errorResult(`Failed to get workflow context: ${err}`);
			}
		},
	);

	// ── get_event_history ─────────────────────────────
	mcpServer.registerTool(
		"get_event_history",
		{
			title: "Get Event History",
			description:
				"Get recent agent events (tool calls, LLM completions, lifecycle events). Newest first.",
			inputSchema: {
				limit: z
					.number()
					.optional()
					.describe("Max events to return (default 50)"),
			},
			_meta: uiMeta,
		},
		async (args: { limit?: number }) => {
			try {
				const events = eventBus.getRecentEvents(args.limit ?? 50);
				return textResult(events);
			} catch (err) {
				return errorResult(`Failed to get event history: ${err}`);
			}
		},
	);

	return mcpServer.server;
}
