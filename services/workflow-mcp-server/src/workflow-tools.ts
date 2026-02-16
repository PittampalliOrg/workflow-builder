/**
 * Workflow MCP Tool Registration
 *
 * Registers MCP tools for workflow CRUD, node/edge manipulation,
 * execution, approval, and observability, with optional UI resource.
 */

import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	registerAppResource,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import * as db from "./db.js";
import type { UiSession } from "./ui/session.js";
import { registerUiTools } from "./ui/tools.js";

export type RegisteredTool = {
	name: string;
	description: string;
};

const NODE_TYPES = [
	"trigger",
	"action",
	"activity",
	"approval-gate",
	"timer",
	"loop-until",
	"if-else",
	"note",
	"set-state",
	"transform",
	"publish-event",
] as const;

type NodeTypeEnum = (typeof NODE_TYPES)[number];

const ORCHESTRATOR_URL =
	process.env.WORKFLOW_ORCHESTRATOR_URL ?? "http://workflow-orchestrator:8080";

/** Helper: JSON text response */
function textResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

/** Helper: error response */
function errorResult(msg: string) {
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true,
	};
}

/**
 * Register all workflow tools on an McpServer instance with UI.
 */
export function registerWorkflowTools(
	server: McpServer,
	uiHtmlPath: string,
	userId?: string,
	uiSession?: UiSession,
): RegisteredTool[] {
	const effectiveUserId = userId ?? process.env.USER_ID ?? undefined;
	const htmlContent = fs.readFileSync(uiHtmlPath, "utf-8");
	const resourceUri = "ui://workflow-builder-mcp/app.html";

	registerAppResource(
		server,
		"Workflow Builder UI",
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

	if (uiSession) {
		registerUiTools(server, uiSession, uiMeta);
		tools.push({
			name: "ui_bootstrap",
			description: "Bootstrap Remote DOM UI mutations",
		});
		tools.push({
			name: "ui_updates",
			description: "Poll Remote DOM UI mutations",
		});
		tools.push({
			name: "ui_event",
			description: "Send UI event to server-owned UI",
		});
	}

	// ── list_workflows ─────────────────────────────────────
	(server as any).registerTool(
		"list_workflows",
		{
			title: "List Workflows",
			description:
				"List all workflows with summary info (name, node/edge counts, dates). Does not return full node/edge data.",
			inputSchema: {},
			_meta: uiMeta,
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
		description: "List all workflows (summary)",
	});

	// ── get_workflow ────────────────────────────────────────
	(server as any).registerTool(
		"get_workflow",
		{
			title: "Get Workflow",
			description: "Get a workflow by ID, including full nodes and edges data.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
			},
			_meta: uiMeta,
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
	tools.push({ name: "get_workflow", description: "Get full workflow by ID" });

	// ── create_workflow ────────────────────────────────────
	(server as any).registerTool(
		"create_workflow",
		{
			title: "Create Workflow",
			description: "Create a new workflow with a default manual trigger node.",
			inputSchema: {
				name: z.string().describe("Workflow name"),
				description: z.string().optional().describe("Workflow description"),
			},
			_meta: uiMeta,
		},
		async (args: { name: string; description?: string }) => {
			try {
				const wf = await db.createWorkflow(
					args.name,
					args.description,
					effectiveUserId,
				);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to create workflow: ${err}`);
			}
		},
	);
	tools.push({
		name: "create_workflow",
		description: "Create workflow with default trigger",
	});

	// ── update_workflow ────────────────────────────────────
	(server as any).registerTool(
		"update_workflow",
		{
			title: "Update Workflow",
			description: "Update workflow metadata (name, description, visibility).",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				name: z.string().optional().describe("New name"),
				description: z.string().optional().describe("New description"),
				visibility: z
					.enum(["private", "public"])
					.optional()
					.describe("Visibility"),
			},
			_meta: uiMeta,
		},
		async (args: {
			workflow_id: string;
			name?: string;
			description?: string;
			visibility?: string;
		}) => {
			try {
				const { workflow_id, ...fields } = args;
				const wf = await db.updateWorkflow(workflow_id, fields);
				if (!wf) return errorResult(`Workflow "${workflow_id}" not found`);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to update workflow: ${err}`);
			}
		},
	);
	tools.push({
		name: "update_workflow",
		description: "Update workflow metadata",
	});

	// ── delete_workflow ────────────────────────────────────
	(server as any).registerTool(
		"delete_workflow",
		{
			title: "Delete Workflow",
			description: "Permanently delete a workflow.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID to delete"),
			},
			_meta: uiMeta,
		},
		async (args: { workflow_id: string }) => {
			try {
				const ok = await db.deleteWorkflow(args.workflow_id);
				if (!ok) return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult({ deleted: true, id: args.workflow_id });
			} catch (err) {
				return errorResult(`Failed to delete workflow: ${err}`);
			}
		},
	);
	tools.push({ name: "delete_workflow", description: "Delete a workflow" });

	// ── duplicate_workflow ─────────────────────────────────
	(server as any).registerTool(
		"duplicate_workflow",
		{
			title: "Duplicate Workflow",
			description:
				"Clone a workflow with new IDs for all nodes and edges. Integration references are stripped.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID to duplicate"),
			},
			_meta: uiMeta,
		},
		async (args: { workflow_id: string }) => {
			try {
				const wf = await db.duplicateWorkflow(
					args.workflow_id,
					effectiveUserId,
				);
				if (!wf) return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to duplicate workflow: ${err}`);
			}
		},
	);
	tools.push({
		name: "duplicate_workflow",
		description: "Clone workflow with new IDs",
	});

	// ── add_node ──────────────────────────────────────────
	(server as any).registerTool(
		"add_node",
		{
			title: "Add Node",
			description:
				"Add a new node to a workflow. Auto-positions below existing nodes if position not specified. Use connect_from_node_id to auto-connect from an existing node.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				type: z.enum(NODE_TYPES).describe("Node type"),
				label: z.string().describe("Display label for the node"),
				position_x: z
					.number()
					.optional()
					.describe("X position (auto-calculated if omitted)"),
				position_y: z
					.number()
					.optional()
					.describe("Y position (auto-calculated if omitted)"),
				config: z
					.record(z.any())
					.optional()
					.describe("Node configuration (e.g. actionType for action nodes)"),
				connect_from_node_id: z
					.string()
					.optional()
					.describe(
						"If provided, automatically creates an edge from this node to the new node",
					),
			},
			_meta: uiMeta,
		},
		async (args: {
			workflow_id: string;
			type: NodeTypeEnum;
			label: string;
			position_x?: number;
			position_y?: number;
			config?: Record<string, unknown>;
			connect_from_node_id?: string;
		}) => {
			try {
				// Auto-position: place below the lowest existing node
				let posX = args.position_x;
				let posY = args.position_y;
				if (posX === undefined || posY === undefined) {
					const existing = await db.getWorkflow(args.workflow_id);
					if (existing && existing.nodes.length > 0) {
						const nodes = existing.nodes;
						const maxY = Math.max(...nodes.map((n) => n.position.y));
						const avgX =
							nodes.reduce((sum, n) => sum + n.position.x, 0) / nodes.length;
						posX = posX ?? Math.round(avgX);
						posY = posY ?? maxY + 120;
					} else {
						posX = posX ?? 0;
						posY = posY ?? 0;
					}
				}

				const node: db.NodeData = {
					id: nanoid(),
					type: args.type,
					position: { x: posX, y: posY },
					data: {
						label: args.label,
						type: args.type,
						config: args.config,
						status: "idle",
						enabled: true,
					},
				};
				let wf = await db.addNode(args.workflow_id, node);
				if (!wf) return errorResult(`Workflow "${args.workflow_id}" not found`);

				// Auto-connect if requested
				let addedEdge: db.EdgeData | undefined;
				if (args.connect_from_node_id) {
					const edge: db.EdgeData = {
						id: nanoid(),
						source: args.connect_from_node_id,
						target: node.id,
					};
					const updated = await db.connectNodes(args.workflow_id, edge);
					if (updated) {
						wf = updated;
						addedEdge = edge;
					}
				}

				return textResult({
					added_node: node,
					added_edge: addedEdge ?? null,
					workflow: wf,
				});
			} catch (err) {
				return errorResult(`Failed to add node: ${err}`);
			}
		},
	);
	tools.push({ name: "add_node", description: "Add a node to a workflow" });

	// ── update_node ───────────────────────────────────────
	(server as any).registerTool(
		"update_node",
		{
			title: "Update Node",
			description:
				"Update properties of an existing node (label, description, position, config, enabled).",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				node_id: z.string().describe("The node ID to update"),
				label: z.string().optional().describe("New label"),
				description: z.string().optional().describe("New description"),
				position_x: z.number().optional().describe("New X position"),
				position_y: z.number().optional().describe("New Y position"),
				config: z.record(z.any()).optional().describe("Config fields to merge"),
				enabled: z.boolean().optional().describe("Enable/disable the node"),
			},
			_meta: uiMeta,
		},
		async (args: {
			workflow_id: string;
			node_id: string;
			label?: string;
			description?: string;
			position_x?: number;
			position_y?: number;
			config?: Record<string, unknown>;
			enabled?: boolean;
		}) => {
			try {
				const updates: Parameters<typeof db.updateNode>[2] = {};
				if (args.label !== undefined) updates.label = args.label;
				if (args.description !== undefined)
					updates.description = args.description;
				if (args.position_x !== undefined || args.position_y !== undefined) {
					// Fetch current position to preserve unspecified axis
					const current = await db.getWorkflow(args.workflow_id);
					const existingNode = current?.nodes.find(
						(n) => n.id === args.node_id,
					);
					updates.position = {
						x: args.position_x ?? existingNode?.position.x ?? 0,
						y: args.position_y ?? existingNode?.position.y ?? 0,
					};
				}
				if (args.config !== undefined) updates.config = args.config;
				if (args.enabled !== undefined) updates.enabled = args.enabled;

				const wf = await db.updateNode(args.workflow_id, args.node_id, updates);
				if (!wf) return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to update node: ${err}`);
			}
		},
	);
	tools.push({
		name: "update_node",
		description: "Update a node's properties",
	});

	// ── delete_node ───────────────────────────────────────
	(server as any).registerTool(
		"delete_node",
		{
			title: "Delete Node",
			description: "Remove a node and all connected edges from a workflow.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				node_id: z.string().describe("The node ID to delete"),
			},
			_meta: uiMeta,
		},
		async (args: { workflow_id: string; node_id: string }) => {
			try {
				const wf = await db.deleteNode(args.workflow_id, args.node_id);
				if (!wf) return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to delete node: ${err}`);
			}
		},
	);
	tools.push({
		name: "delete_node",
		description: "Remove node and connected edges",
	});

	// ── connect_nodes ─────────────────────────────────────
	(server as any).registerTool(
		"connect_nodes",
		{
			title: "Connect Nodes",
			description: "Add an edge between two nodes in a workflow.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				source_node_id: z.string().describe("Source node ID"),
				target_node_id: z.string().describe("Target node ID"),
				source_handle: z.string().optional().describe("Source handle ID"),
				target_handle: z.string().optional().describe("Target handle ID"),
			},
			_meta: uiMeta,
		},
		async (args: {
			workflow_id: string;
			source_node_id: string;
			target_node_id: string;
			source_handle?: string;
			target_handle?: string;
		}) => {
			try {
				const edge: db.EdgeData = {
					id: nanoid(),
					source: args.source_node_id,
					target: args.target_node_id,
					sourceHandle: args.source_handle,
					targetHandle: args.target_handle,
				};
				const wf = await db.connectNodes(args.workflow_id, edge);
				if (!wf) return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult({ added_edge: edge, workflow: wf });
			} catch (err) {
				return errorResult(`Failed to connect nodes: ${err}`);
			}
		},
	);
	tools.push({
		name: "connect_nodes",
		description: "Add an edge between nodes",
	});

	// ── disconnect_nodes ──────────────────────────────────
	(server as any).registerTool(
		"disconnect_nodes",
		{
			title: "Disconnect Nodes",
			description: "Remove an edge from a workflow by edge ID.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				edge_id: z.string().describe("The edge ID to remove"),
			},
			_meta: uiMeta,
		},
		async (args: { workflow_id: string; edge_id: string }) => {
			try {
				const wf = await db.disconnectNodes(args.workflow_id, args.edge_id);
				if (!wf) return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to disconnect nodes: ${err}`);
			}
		},
	);
	tools.push({
		name: "disconnect_nodes",
		description: "Remove an edge by ID",
	});

	// ── list_available_actions ─────────────────────────────
	(server as any).registerTool(
		"list_available_actions",
		{
			title: "List Available Actions",
			description:
				"Browse the action catalog — builtin functions and Activepieces piece actions. Optionally filter by search term.",
			inputSchema: {
				search: z
					.string()
					.optional()
					.describe("Search filter (matches slug, name, description)"),
			},
			_meta: uiMeta,
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
				"Start a workflow execution via the orchestrator. Returns the execution instance ID.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID to execute"),
				trigger_data: z
					.record(z.any())
					.optional()
					.describe("Input data for the trigger node"),
			},
			_meta: uiMeta,
		},
		async (args: {
			workflow_id: string;
			trigger_data?: Record<string, unknown>;
		}) => {
			try {
				const resp = await fetch(
					`${ORCHESTRATOR_URL}/api/v2/workflows/execute-by-id`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							workflowId: args.workflow_id,
							triggerData: args.trigger_data ?? {},
						}),
					},
				);

				if (!resp.ok) {
					const text = await resp.text();
					return errorResult(`Orchestrator returned ${resp.status}: ${text}`);
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
		description: "Run workflow via orchestrator",
	});

	// ── get_execution_status ──────────────────────────────
	(server as any).registerTool(
		"get_execution_status",
		{
			title: "Get Execution Status",
			description:
				"Poll the orchestrator for workflow execution status. Returns status, phase, and approvalEventName when awaiting approval.",
			inputSchema: {
				instance_id: z
					.string()
					.describe("Dapr workflow instanceId (from execute_workflow result)"),
			},
			_meta: uiMeta,
		},
		async (args: { instance_id: string }) => {
			try {
				const resp = await fetch(
					`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(args.instance_id)}/status`,
				);
				if (!resp.ok) {
					const text = await resp.text();
					return errorResult(`Orchestrator returned ${resp.status}: ${text}`);
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
		description: "Poll workflow execution status",
	});

	// ── approve_workflow ───────────────────────────────────
	(server as any).registerTool(
		"approve_workflow",
		{
			title: "Approve Workflow",
			description:
				"Raise an approval or rejection event on a running workflow that is awaiting an approval gate.",
			inputSchema: {
				instance_id: z.string().describe("Dapr workflow instanceId"),
				event_name: z
					.string()
					.describe(
						"The approval event name (from approvalEventName in status)",
					),
				approved: z.boolean().describe("true to approve, false to reject"),
				reason: z
					.string()
					.optional()
					.describe("Optional reason for the approval/rejection"),
			},
			_meta: uiMeta,
		},
		async (args: {
			instance_id: string;
			event_name: string;
			approved: boolean;
			reason?: string;
		}) => {
			try {
				const resp = await fetch(
					`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(args.instance_id)}/events`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							eventName: args.event_name,
							eventData: {
								approved: args.approved,
								reason: args.reason,
							},
						}),
					},
				);
				if (!resp.ok) {
					const text = await resp.text();
					return errorResult(`Orchestrator returned ${resp.status}: ${text}`);
				}
				const result = await resp.json();
				return textResult(result);
			} catch (err) {
				return errorResult(`Failed to send approval event: ${err}`);
			}
		},
	);
	tools.push({
		name: "approve_workflow",
		description: "Approve or reject a workflow approval gate",
	});

	// ── get_execution_results ─────────────────────────────
	(server as any).registerTool(
		"get_execution_results",
		{
			title: "Get Execution Results",
			description:
				"Get per-node execution results with input/output data for a completed workflow run.",
			inputSchema: {
				instance_id: z
					.string()
					.describe("Dapr workflow instanceId (from execute_workflow result)"),
			},
			_meta: uiMeta,
		},
		async (args: { instance_id: string }) => {
			try {
				const execution = await db.getExecutionByInstanceId(args.instance_id);
				if (!execution)
					return errorResult(
						`Execution not found for instance "${args.instance_id}"`,
					);
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

	// ── get_workflow_observability ─────────────────────────
	(server as any).registerTool(
		"get_workflow_observability",
		{
			title: "Get Workflow Observability",
			description:
				"Generate TraceQL/LogQL/PromQL helpers (and optional Grafana Explore links) for a workflow instance.",
			inputSchema: {
				instance_id: z
					.string()
					.describe("Dapr workflow instanceId (from execute_workflow result)"),
				workflow_id: z
					.string()
					.optional()
					.describe("Workflow definition/database ID (optional)"),
				db_execution_id: z
					.string()
					.optional()
					.describe("workflow_executions.id (optional)"),
				trace_id: z
					.string()
					.optional()
					.describe(
						"OpenTelemetry trace_id (optional; preferred for log correlation)",
					),
				minutes: z
					.number()
					.optional()
					.describe("Time range in minutes for Explore links (default 60)"),
			},
			_meta: uiMeta,
		},
		async (args: {
			instance_id: string;
			workflow_id?: string;
			db_execution_id?: string;
			trace_id?: string;
			minutes?: number;
		}) => {
			try {
				const minutes = args.minutes ?? 60;

				let traceId = args.trace_id;
				if (!traceId) {
					// Best-effort: ask orchestrator for its custom status traceId field.
					try {
						const resp = await fetch(
							`${ORCHESTRATOR_URL}/api/v2/workflows/${encodeURIComponent(args.instance_id)}/status`,
						);
						if (resp.ok) {
							const status = (await resp.json()) as { traceId?: string };
							if (status?.traceId) traceId = status.traceId;
						}
					} catch {
						// non-fatal
					}
				}

				const serviceName = "workflow-orchestrator";

				const traceql = traceId
					? [
							`{ resource.service.name = "${serviceName}" } | trace_id = "${traceId}"`,
						]
					: [
							`{ resource.service.name = "${serviceName}" } | span.workflow.instance_id = "${args.instance_id}"`,
						];

				const logql = traceId
					? [
							`{service="${serviceName}"} | json | trace_id="${traceId}"`,
							`{service="${serviceName}"} |= "${traceId}"`,
						]
					: [`{service="${serviceName}"} |= "${args.instance_id}"`];

				const promql = [
					`sum(rate(http_server_request_duration_seconds_count{service_name="${serviceName}"}[5m]))`,
					`sum(rate(http_server_request_duration_seconds_sum{service_name="${serviceName}"}[5m])) / sum(rate(http_server_request_duration_seconds_count{service_name="${serviceName}"}[5m]))`,
				];

				const grafanaBaseUrl = process.env.GRAFANA_BASE_URL;
				const tempoUid = process.env.GRAFANA_TEMPO_DS_UID;
				const lokiUid = process.env.GRAFANA_LOKI_DS_UID;
				const promUid = process.env.GRAFANA_PROM_DS_UID;

				function exploreLink(params: {
					dsUid: string | undefined;
					query: string;
					queryType?: string;
				}): string | null {
					if (!grafanaBaseUrl || !params.dsUid) return null;
					const left = {
						datasource: params.dsUid,
						queries: [
							{
								refId: "A",
								query: params.query,
								queryType: params.queryType,
							},
						],
						range: { from: `now-${minutes}m`, to: "now" },
					};
					return `${grafanaBaseUrl.replace(/\/$/, "")}/explore?left=${encodeURIComponent(JSON.stringify(left))}`;
				}

				return textResult({
					input: args,
					resolved: {
						traceId: traceId ?? null,
					},
					queries: { traceql, logql, promql },
					links: {
						traces: exploreLink({
							dsUid: tempoUid,
							query: traceql[0] ?? "",
							queryType: "traceql",
						}),
						logs: exploreLink({
							dsUid: lokiUid,
							query: logql[0] ?? "",
						}),
						metrics: exploreLink({
							dsUid: promUid,
							query: promql[0] ?? "",
						}),
					},
				});
			} catch (err) {
				return errorResult(`Failed to build observability helpers: ${err}`);
			}
		},
	);
	tools.push({
		name: "get_workflow_observability",
		description: "Generate traces/logs/metrics queries and Explore links",
	});

	return tools;
}
