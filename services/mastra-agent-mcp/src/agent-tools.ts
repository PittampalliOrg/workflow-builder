/**
 * MCP Tool Registration
 *
 * 4 MCP tools + 1 UI resource for the Mastra Agent monitor.
 */

import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	registerAppResource,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { eventBus } from "./event-bus.js";
import { runAgent } from "./agent.js";

export type RegisteredTool = {
	name: string;
	description: string;
};

// Cache UI HTML at module level to avoid re-reading per session
let cachedHtmlContent: string | null = null;

export function preloadUiHtml(uiHtmlPath: string): void {
	cachedHtmlContent = fs.readFileSync(uiHtmlPath, "utf-8");
}

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

export function registerAgentTools(
	server: McpServer,
	uiHtmlPath: string,
): RegisteredTool[] {
	const htmlContent = cachedHtmlContent ?? fs.readFileSync(uiHtmlPath, "utf-8");
	const resourceUri = "ui://mastra-agent-mcp/app.html";

	registerAppResource(
		server,
		"Mastra Agent Monitor UI",
		resourceUri,
		{ mimeType: RESOURCE_MIME_TYPE },
		async () => ({
			contents: [
				{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: htmlContent },
			],
		}),
	);

	const uiMeta = {
		ui: { resourceUri },
		"ui/resourceUri": resourceUri,
	};

	const tools: RegisteredTool[] = [];

	// ── get_agent_status ───────────────────────────────
	server.registerTool(
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
	tools.push({
		name: "get_agent_status",
		description: "Get agent status and metrics",
	});

	// ── run_agent ──────────────────────────────────────
	(server as any).registerTool(
		"run_agent",
		{
			title: "Run Agent",
			description:
				"Run the Mastra agent with a prompt. Returns the agent's text response, tool calls made, and token usage.",
			inputSchema: {
				prompt: z.string().describe("The prompt to send to the agent"),
			},
			_meta: uiMeta,
		} as any,
		async (args: any) => {
			try {
				const prompt = args?.prompt;
				if (typeof prompt !== "string" || !prompt.trim()) {
					return errorResult("prompt is required");
				}
				const result = await runAgent(prompt);
				return textResult(result);
			} catch (err) {
				return errorResult(`Agent run failed: ${err}`);
			}
		},
	);
	tools.push({ name: "run_agent", description: "Run agent with a prompt" });

	// ── get_workflow_context ───────────────────────────
	server.registerTool(
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
	tools.push({
		name: "get_workflow_context",
		description: "Get Dapr workflow context",
	});

	// ── get_event_history ─────────────────────────────
	server.registerTool(
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
	tools.push({
		name: "get_event_history",
		description: "Get recent agent events",
	});

	return tools;
}
