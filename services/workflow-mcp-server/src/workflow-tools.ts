/**
 * Workflow MCP Tool Registration
 *
 * This surface is intentionally operational/read-only for workflow definitions.
 * Workflow authoring now flows through the BFF/spec adapter and the dynamic-script
 * tools; direct canvas CRUD/node mutation here bypassed that boundary and drifted
 * from current workflow-builder semantics.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as db from "./db.js";
import { currentGoalSessionId } from "./goal-context.js";
import { setSpanOutput } from "./observability/content.js";

export type RegisteredTool = {
	name: string;
	description: string;
};

const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ??
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

/** Helper: JSON text response */
function textResult(data: unknown) {
	setSpanOutput(data);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

/** Helper: error response */
function errorResult(msg: string) {
	setSpanOutput({ error: msg });
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true,
	};
}

function internalHeaders(userId?: string): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Internal-Token": INTERNAL_API_TOKEN,
	};
	const sessionId = currentGoalSessionId();
	if (sessionId) headers["X-Wfb-Session-Id"] = sessionId;
	if (userId) headers["X-User-Id"] = userId;
	return headers;
}

function resolveExecutionRef(args: {
	execution_id?: string;
	instance_id?: string;
}): string | null {
	const ref = args.execution_id ?? args.instance_id;
	return typeof ref === "string" && ref.trim() ? ref.trim() : null;
}

/**
 * Register current workflow tools on an McpServer instance.
 *
 * Deprecated parameters are kept for call-site compatibility with older UI
 * resource wiring, but this module no longer registers Remote DOM or canvas
 * mutation tools.
 */
export function registerWorkflowTools(
	server: McpServer,
	_uiHtmlPath?: string,
	userId?: string,
	_uiSession?: unknown,
): RegisteredTool[] {
	const effectiveUserId = userId ?? process.env.USER_ID ?? undefined;
	const tools: RegisteredTool[] = [];

	// ── list_workflows ─────────────────────────────────────
	(server as any).registerTool(
		"list_workflows",
		{
			title: "List Workflows",
			description:
				"List workflows with summary metadata, engine type, and node/edge counts. Does not return full spec/node data.",
			inputSchema: {},
		},
		async () => {
			try {
				const workflows = await db.listWorkflows(effectiveUserId);
				return textResult(workflows);
			} catch (err) {
				return errorResult(`Failed to list workflows: ${err}`);
			}
		},
	);
	tools.push({
		name: "list_workflows",
		description: "List workflows with current engine metadata",
	});

	// ── get_workflow ────────────────────────────────────────
	(server as any).registerTool(
		"get_workflow",
		{
			title: "Get Workflow",
			description:
				"Get a workflow by ID, including current spec metadata and legacy node/edge data when present.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
			},
		},
		async (args: { workflow_id: string }) => {
			try {
				const wf = await db.getWorkflow(args.workflow_id);
				if (!wf) return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to get workflow: ${err}`);
			}
		},
	);
	tools.push({
		name: "get_workflow",
		description: "Get workflow definition metadata and spec",
	});

	// ── list_available_actions ─────────────────────────────
	(server as any).registerTool(
		"list_available_actions",
		{
			title: "List Available Actions",
			description:
				"Browse the current action catalog — builtin functions, durable/run, and Activepieces piece actions. Optionally filter by search term.",
			inputSchema: {
				search: z
					.string()
					.optional()
					.describe("Search filter (matches slug, name, description)"),
			},
		},
		async (args: { search?: string }) => {
			try {
				const actions = await db.listAvailableActions(args.search);
				return textResult(actions);
			} catch (err) {
				return errorResult(`Failed to list actions: ${err}`);
			}
		},
	);
	tools.push({
		name: "list_available_actions",
		description: "Browse action catalog",
	});

	// ── execute_workflow ───────────────────────────────────
	(server as any).registerTool(
		"execute_workflow",
		{
			title: "Execute Workflow",
			description:
				"Start a saved workflow execution through the workflow-builder internal agent API. For inline dynamic scripts, use run_workflow_script.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID to execute"),
				trigger_data: z
					.record(z.any())
					.optional()
					.describe("Input data for the workflow trigger"),
			},
		},
		async (args: {
			workflow_id: string;
			trigger_data?: Record<string, unknown>;
		}) => {
			try {
				if (!INTERNAL_API_TOKEN) {
					return errorResult(
						"INTERNAL_API_TOKEN is not configured for workflow execution",
					);
				}
				const resp = await fetch(
					`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/execute`,
					{
						method: "POST",
						headers: internalHeaders(effectiveUserId),
						body: JSON.stringify({
							workflowId: args.workflow_id,
							triggerData: args.trigger_data ?? {},
						}),
					},
				);

				if (!resp.ok) {
					const text = await resp.text();
					return errorResult(`Workflow API returned ${resp.status}: ${text}`);
				}

				const result = await resp.json();
				return textResult(result);
			} catch (err) {
				return errorResult(`Failed to execute workflow: ${err}`);
			}
		},
	);
	tools.push({
		name: "execute_workflow",
		description: "Run saved workflow through the BFF internal API",
	});

	// ── get_execution_status ──────────────────────────────
	(server as any).registerTool(
		"get_execution_status",
		{
			title: "Get Execution Status",
			description:
				"Poll workflow execution status through the workflow-builder internal agent API. Accepts execution_id or the legacy Dapr instance_id.",
			inputSchema: {
				execution_id: z
					.string()
					.optional()
					.describe("workflow_executions.id from execute_workflow"),
				instance_id: z
					.string()
					.optional()
					.describe("Legacy Dapr instanceId; resolved to execution_id when possible"),
			},
		},
		async (args: { execution_id?: string; instance_id?: string }) => {
			try {
				if (!INTERNAL_API_TOKEN) {
					return errorResult(
						"INTERNAL_API_TOKEN is not configured for workflow status polling",
					);
				}
				const ref = resolveExecutionRef(args);
				if (!ref) {
					return errorResult("Provide execution_id or instance_id.");
				}
				const execution = await db.getExecutionByInstanceId(ref);
				const executionId = execution?.id ?? ref;
				const resp = await fetch(
					`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/executions/${encodeURIComponent(
						executionId,
					)}/status`,
					{ headers: internalHeaders(effectiveUserId) },
				);
				if (!resp.ok) {
					const text = await resp.text();
					return errorResult(`Workflow API returned ${resp.status}: ${text}`);
				}
				const result = await resp.json();
				return textResult(result);
			} catch (err) {
				return errorResult(`Failed to get execution status: ${err}`);
			}
		},
	);
	tools.push({
		name: "get_execution_status",
		description: "Poll workflow execution status through the BFF",
	});

	// ── get_execution_results ─────────────────────────────
	(server as any).registerTool(
		"get_execution_results",
		{
			title: "Get Execution Results",
			description:
				"Get per-node execution results with input/output data for a completed workflow run. Accepts execution_id or the legacy Dapr instance_id.",
			inputSchema: {
				execution_id: z
					.string()
					.optional()
					.describe("workflow_executions.id from execute_workflow"),
				instance_id: z
					.string()
					.optional()
					.describe("Legacy Dapr workflow instanceId"),
			},
		},
		async (args: { execution_id?: string; instance_id?: string }) => {
			try {
				const ref = resolveExecutionRef(args);
				if (!ref) {
					return errorResult("Provide execution_id or instance_id.");
				}
				const execution = await db.getExecutionByInstanceId(ref);
				if (!execution) {
					return errorResult(`Execution not found for "${ref}"`);
				}
				const logs = await db.getExecutionLogs(execution.id);
				return textResult({ execution, logs });
			} catch (err) {
				return errorResult(`Failed to get execution results: ${err}`);
			}
		},
	);
	tools.push({
		name: "get_execution_results",
		description: "Get per-node execution results",
	});

	return tools;
}
