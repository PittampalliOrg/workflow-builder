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

// ── Global UI HTML cache (read once, shared across all sessions) ──
let _cachedUiHtml: string | null | undefined;
function getUiHtml(): string | null {
	if (_cachedUiHtml !== undefined) return _cachedUiHtml;
	const htmlPath = resolveUiHtml();
	if (htmlPath) {
		_cachedUiHtml = fs.readFileSync(htmlPath, "utf-8");
		console.log(`[mastra-tanstack] UI resource loaded from: ${htmlPath} (${(_cachedUiHtml.length / 1024).toFixed(0)}KB, cached globally)`);
	} else {
		_cachedUiHtml = null;
		console.warn("[mastra-tanstack] UI HTML not found — tools will work without interactive UI");
	}
	return _cachedUiHtml;
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

	const htmlContent = getUiHtml();

	const uiMeta: Record<string, unknown> = {};

	if (htmlContent) {
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

	// ── get_logs ─────────────────────────────────
	mcpServer.registerTool(
		"get_logs",
		{
			title: "Get Server Logs",
			description:
				"Get recent server console logs (log, warn, error, info). Oldest first.",
			inputSchema: {
				limit: z
					.number()
					.optional()
					.describe("Max logs to return (default 100)"),
				level: z
					.string()
					.optional()
					.describe("Filter by level: log, warn, error, info"),
			},
			_meta: uiMeta,
		},
		async (args: { limit?: number; level?: string }) => {
			try {
				let logs = eventBus.getRecentLogs(args.limit ?? 100);
				if (args.level) {
					logs = logs.filter((l) => l.level === args.level);
				}
				return textResult(logs);
			} catch (err) {
				return errorResult(`Failed to get logs: ${err}`);
			}
		},
	);

	// ── run_workflow ─────────────────────────────
	mcpServer.registerTool(
		"run_workflow",
		{
			title: "Run Workflow",
			description:
				"Run a workflow by its database ID via the Dapr workflow orchestrator. Passes prompt and optional repo info as triggerData.",
			inputSchema: {
				workflowId: z
					.string()
					.default("yptntuid5sk3cqjymg8kw")
					.describe("Workflow database ID"),
				prompt: z.string().describe("The prompt/instructions for the workflow"),
				repo_owner: z.string().optional().describe("Repository owner (GitHub org/user)"),
				repo_name: z.string().optional().describe("Repository name"),
				branch: z.string().optional().default("main").describe("Git branch"),
			},
			_meta: uiMeta,
		},
		async (args: {
			workflowId: string;
			prompt: string;
			repo_owner?: string;
			repo_name?: string;
			branch?: string;
		}) => {
			try {
				const daprHost = process.env.DAPR_HOST || "localhost";
				const daprPort = process.env.DAPR_HTTP_PORT || "3500";
				const url = `http://${daprHost}:${daprPort}/v1.0/invoke/workflow-orchestrator/method/api/v2/workflows/execute-by-id`;

				const body = {
					workflowId: args.workflowId,
					triggerData: {
						prompt: args.prompt,
						...(args.repo_owner && { repo_owner: args.repo_owner }),
						...(args.repo_name && { repo_name: args.repo_name }),
						...(args.branch && { branch: args.branch }),
					},
				};

				const resp = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});

				if (!resp.ok) {
					const errText = await resp.text();
					return errorResult(`Workflow execution failed (${resp.status}): ${errText}`);
				}

				const result = await resp.json();

				// Set workflow context on eventBus for monitoring
				eventBus.setWorkflowContext({
					workflowId: args.workflowId,
					instanceId: result.instanceId,
					status: result.status,
				});

				return textResult(result);
			} catch (err) {
				return errorResult(`Failed to run workflow: ${err}`);
			}
		},
	);

	// ── get_workflow_execution_status ─────────────
	mcpServer.registerTool(
		"get_workflow_execution_status",
		{
			title: "Get Workflow Execution Status",
			description:
				"Get the status of a running workflow execution by its instance ID.",
			inputSchema: {
				instanceId: z.string().describe("The Dapr workflow instance ID"),
			},
			_meta: uiMeta,
		},
		async (args: { instanceId: string }) => {
			try {
				const daprHost = process.env.DAPR_HOST || "localhost";
				const daprPort = process.env.DAPR_HTTP_PORT || "3500";
				const url = `http://${daprHost}:${daprPort}/v1.0/invoke/workflow-orchestrator/method/api/v2/workflows/${encodeURIComponent(args.instanceId)}/status`;

				const resp = await fetch(url, {
					method: "GET",
					headers: { "Content-Type": "application/json" },
				});

				if (!resp.ok) {
					const errText = await resp.text();
					return errorResult(`Status check failed (${resp.status}): ${errText}`);
				}

				const result = await resp.json();
				return textResult(result);
			} catch (err) {
				return errorResult(`Failed to get workflow status: ${err}`);
			}
		},
	);

	// ── approve_workflow ─────────────────────────
	mcpServer.registerTool(
		"approve_workflow",
		{
			title: "Approve or Reject Workflow",
			description:
				"Approve or reject a workflow that is waiting at an approval gate. Raises the named external event.",
			inputSchema: {
				instanceId: z.string().describe("The Dapr workflow instance ID"),
				eventName: z.string().describe("The approval event name (from status.approvalEventName)"),
				approved: z.boolean().describe("true to approve, false to reject"),
				reason: z.string().optional().describe("Optional reason for approval/rejection"),
			},
			_meta: uiMeta,
		},
		async (args: {
			instanceId: string;
			eventName: string;
			approved: boolean;
			reason?: string;
		}) => {
			try {
				const daprHost = process.env.DAPR_HOST || "localhost";
				const daprPort = process.env.DAPR_HTTP_PORT || "3500";
				const url = `http://${daprHost}:${daprPort}/v1.0/invoke/workflow-orchestrator/method/api/v2/workflows/${encodeURIComponent(args.instanceId)}/events`;

				const resp = await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						eventName: args.eventName,
						eventData: {
							approved: args.approved,
							reason: args.reason || (args.approved ? "Approved" : "Rejected"),
						},
					}),
				});

				if (!resp.ok) {
					const errText = await resp.text();
					return errorResult(`Approval failed (${resp.status}): ${errText}`);
				}

				const result = await resp.json();
				return textResult(result);
			} catch (err) {
				return errorResult(`Failed to approve workflow: ${err}`);
			}
		},
	);

	return mcpServer.server;
}
