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
import { callRemoteWorkflowTargetTool } from "./remote-mcp.js";
import { resolveWorkflowTarget } from "./targets.js";

export type RegisteredTool = {
	name: string;
	description: string;
};

const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ??
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const targetInput = z
	.string()
	.optional()
	.describe(
		'Workflow runtime target. Omit or use "dev" for the host dev cluster; use "preview:<name>" for a vCluster preview.',
	);

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

async function proxyTargetTool(
	toolName: string,
	args: Record<string, unknown>,
	userId?: string,
) {
	const target = await resolveWorkflowTarget(
		typeof args.target === "string" ? args.target : undefined,
	);
	if (target.local) return null;
	return callRemoteWorkflowTargetTool(target, toolName, args, {
		userId,
		sessionId:
			typeof args.sessionId === "string" ? args.sessionId : currentGoalSessionId(),
	});
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
				"List workflows with summary metadata, engine type, and node/edge counts. Does not return full spec/node data. Defaults to the 50 most recently updated in COMPACT form (id | name | engine); pass summary:false for full metadata rows, and limit to change the cap (max 500).",
			inputSchema: {
				target: targetInput,
				limit: z.number().int().positive().max(500).optional()
					.describe("Max workflows returned, most recently updated first (default 50)."),
				summary: z.boolean().optional()
					.describe("true (default): compact 'id | name | engine' lines. false: full metadata objects."),
			},
		},
		async (args: { target?: string; limit?: number; summary?: boolean } = {}) => {
			try {
				const proxied = await proxyTargetTool(
					"list_workflows",
					args as Record<string, unknown>,
					effectiveUserId,
				);
				if (proxied) return proxied;
				const limit = args.limit ?? 50;
				const workflows = await db.listWorkflows(effectiveUserId, limit);
				if (args.summary !== false) {
					return textResult(
						workflows
							.map((w) => `${w.id} | ${w.name} | ${w.engineType ?? "?"}`)
							.join("\n") || "(no workflows)",
					);
				}
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
				target: targetInput,
			},
		},
		async (args: { workflow_id: string; target?: string }) => {
			try {
				const proxied = await proxyTargetTool(
					"get_workflow",
					args as Record<string, unknown>,
					effectiveUserId,
				);
				if (proxied) return proxied;
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
				target: targetInput,
			},
		},
		async (args: { search?: string; target?: string }) => {
			try {
				const proxied = await proxyTargetTool(
					"list_available_actions",
					args as Record<string, unknown>,
					effectiveUserId,
				);
				if (proxied) return proxied;
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

	// ── create_agent ───────────────────────────────────────
	(server as any).registerTool(
		"create_agent",
		{
			title: "Create Agent",
			description:
				"Register a new agent in the catalog so a workflow (or a run's opts.agent) can dispatch to it. Defaults to the non-CLI 'dapr-agent-py' runtime. Set `model` to a valid modelSpec (e.g. 'zai/glm-5.2' for GLM 5.2). Grant tools by passing `mcp_servers` (each {name,url,transport:'streamable_http'|'stdio', command?, args?}); for a stdio server give command/args instead of url. Use `skills` to attach agent skills. Returns the created agent's id and slug. Owner is resolved from the MCP connection (X-User-Id) or the active session (X-Wfb-Session-Id) — you cannot create an agent for another user.",
			inputSchema: {
				name: z.string().describe("Human-readable agent name."),
				slug: z
					.string()
					.optional()
					.describe("Stable slug (auto-derived from name if omitted)."),
				description: z.string().optional(),
				model: z
					.string()
					.optional()
					.describe(
						"modelSpec, e.g. 'zai/glm-5.2'. Ignored for CLI runtimes (native subscription auth).",
					),
				runtime: z
					.string()
					.optional()
					.describe(
						"Agent runtime (default 'dapr-agent-py'). Other non-CLI options: 'dapr-agent-py-juicefs'.",
					),
				system_prompt: z
					.string()
					.optional()
					.describe("System prompt / persona for the agent."),
				mcp_servers: z
					.array(
						z.object({
							name: z.string(),
							transport: z.string().optional(),
							url: z.string().optional(),
							command: z.string().optional(),
							args: z.array(z.string()).optional(),
						}),
					)
					.optional()
					.describe("MCP servers that provide the agent's tools."),
				tools: z.array(z.string()).optional(),
				skills: z.array(z.string()).optional(),
				tags: z.array(z.string()).optional(),
				project_id: z
					.string()
					.optional()
					.describe("Owning project (defaults to the session's project)."),
			},
		},
		async (args: {
			name: string;
			slug?: string;
			description?: string;
			model?: string;
			runtime?: string;
			system_prompt?: string;
			mcp_servers?: Array<Record<string, unknown>>;
			tools?: string[];
			skills?: string[];
			tags?: string[];
			project_id?: string;
		}) => {
			try {
				if (!INTERNAL_API_TOKEN) {
					return errorResult(
						"INTERNAL_API_TOKEN is not configured for agent creation",
					);
				}
				// Resolve the owner server-side: the connection's X-User-Id, else the
				// active session's owner. Never trust a client-supplied user id.
				const sessionId = currentGoalSessionId();
				let userId = effectiveUserId;
				let projectId = args.project_id ?? null;
				if ((!userId || !projectId) && sessionId) {
					const owner = await db.getSessionOwner(sessionId);
					userId = userId ?? owner?.userId ?? undefined;
					projectId = projectId ?? owner?.projectId ?? null;
				}
				if (!userId) {
					return errorResult(
						"No user context: create_agent needs an authenticated MCP connection (X-User-Id) or a session (X-Wfb-Session-Id).",
					);
				}

				const runtime = args.runtime ?? "dapr-agent-py";
				const config: Record<string, unknown> = { runtime };
				if (args.model) config.modelSpec = args.model;
				if (args.system_prompt) config.systemPrompt = args.system_prompt;
				if (args.mcp_servers) config.mcpServers = args.mcp_servers;
				if (args.tools) config.tools = args.tools;
				if (args.skills) config.skills = args.skills;

				const agentBody: Record<string, unknown> = {
					name: args.name,
					runtime,
					config,
				};
				if (args.slug) agentBody.slug = args.slug;
				if (args.description) agentBody.description = args.description;
				if (args.tags) agentBody.tags = args.tags;
				if (projectId) agentBody.projectId = projectId;

				const resp = await fetch(`${WORKFLOW_BUILDER_URL}/api/internal/agents`, {
					method: "POST",
					headers: internalHeaders(userId),
					body: JSON.stringify({ userId, projectId, agent: agentBody }),
				});
				const data = (await resp.json().catch(() => ({}))) as {
					agent?: { id?: string; slug?: string; name?: string };
					message?: string;
				};
				if (!resp.ok) {
					return errorResult(
						`create_agent failed (${resp.status}): ${data.message ?? JSON.stringify(data)}`,
					);
				}
				return textResult({
					ok: true,
					agent: data.agent,
					hint: "Reference this agent by slug in a workflow (opts.agent) or a run's x-wfb agent input.",
				});
			} catch (err) {
				return errorResult(`Failed to create agent: ${err}`);
			}
		},
	);
	tools.push({
		name: "create_agent",
		description: "Register a new catalog agent",
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
				target: targetInput,
			},
		},
		async (args: {
			workflow_id: string;
			trigger_data?: Record<string, unknown>;
			target?: string;
		}) => {
			try {
				const proxied = await proxyTargetTool(
					"execute_workflow",
					args as Record<string, unknown>,
					effectiveUserId,
				);
				if (proxied) return proxied;
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
				target: targetInput,
			},
		},
		async (args: {
			execution_id?: string;
			instance_id?: string;
			target?: string;
		}) => {
			try {
				const proxied = await proxyTargetTool(
					"get_execution_status",
					args as Record<string, unknown>,
					effectiveUserId,
				);
				if (proxied) return proxied;
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
				target: targetInput,
			},
		},
		async (args: {
			execution_id?: string;
			instance_id?: string;
			target?: string;
		}) => {
			try {
				const proxied = await proxyTargetTool(
					"get_execution_results",
					args as Record<string, unknown>,
					effectiveUserId,
				);
				if (proxied) return proxied;
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
