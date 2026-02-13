/**
 * Workflow MCP Tool Registration
 *
 * Registers 13 MCP tools for workflow CRUD, node/edge manipulation,
 * and execution, with optional UI resource.
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
	process.env.WORKFLOW_ORCHESTRATOR_URL ??
	"http://workflow-orchestrator:8080";

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
): RegisteredTool[] {
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

	// ── list_workflows ─────────────────────────────────────
	server.registerTool(
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
				const workflows = await db.listWorkflows();
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
	server.registerTool(
		"get_workflow",
		{
			title: "Get Workflow",
			description:
				"Get a workflow by ID, including full nodes and edges data.",
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
	server.registerTool(
		"create_workflow",
		{
			title: "Create Workflow",
			description:
				"Create a new workflow with a default manual trigger node.",
			inputSchema: {
				name: z.string().describe("Workflow name"),
				description: z.string().optional().describe("Workflow description"),
			},
			_meta: uiMeta,
		},
		async (args: { name: string; description?: string }) => {
			try {
				const wf = await db.createWorkflow(args.name, args.description);
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
	server.registerTool(
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
	server.registerTool(
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
				if (!ok)
					return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult({ deleted: true, id: args.workflow_id });
			} catch (err) {
				return errorResult(`Failed to delete workflow: ${err}`);
			}
		},
	);
	tools.push({ name: "delete_workflow", description: "Delete a workflow" });

	// ── duplicate_workflow ─────────────────────────────────
	server.registerTool(
		"duplicate_workflow",
		{
			title: "Duplicate Workflow",
			description:
				"Clone a workflow with new IDs for all nodes and edges. Integration references are stripped.",
			inputSchema: {
				workflow_id: z
					.string()
					.describe("The workflow ID to duplicate"),
			},
			_meta: uiMeta,
		},
		async (args: { workflow_id: string }) => {
			try {
				const wf = await db.duplicateWorkflow(args.workflow_id);
				if (!wf)
					return errorResult(`Workflow "${args.workflow_id}" not found`);
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
	server.registerTool(
		"add_node",
		{
			title: "Add Node",
			description:
				"Add a new node to a workflow. Auto-positions below existing nodes if position not specified. Use connect_from_node_id to auto-connect from an existing node.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				type: z
					.enum(NODE_TYPES)
					.describe("Node type"),
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
					.describe("If provided, automatically creates an edge from this node to the new node"),
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
						const avgX = nodes.reduce((sum, n) => sum + n.position.x, 0) / nodes.length;
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
				if (!wf)
					return errorResult(`Workflow "${args.workflow_id}" not found`);

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

				return textResult({ added_node: node, added_edge: addedEdge ?? null, workflow: wf });
			} catch (err) {
				return errorResult(`Failed to add node: ${err}`);
			}
		},
	);
	tools.push({ name: "add_node", description: "Add a node to a workflow" });

	// ── update_node ───────────────────────────────────────
	server.registerTool(
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
				config: z
					.record(z.any())
					.optional()
					.describe("Config fields to merge"),
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
					const existingNode = current?.nodes.find((n) => n.id === args.node_id);
					updates.position = {
						x: args.position_x ?? existingNode?.position.x ?? 0,
						y: args.position_y ?? existingNode?.position.y ?? 0,
					};
				}
				if (args.config !== undefined) updates.config = args.config;
				if (args.enabled !== undefined) updates.enabled = args.enabled;

				const wf = await db.updateNode(
					args.workflow_id,
					args.node_id,
					updates,
				);
				if (!wf)
					return errorResult(`Workflow "${args.workflow_id}" not found`);
				return textResult(wf);
			} catch (err) {
				return errorResult(`Failed to update node: ${err}`);
			}
		},
	);
	tools.push({ name: "update_node", description: "Update a node's properties" });

	// ── delete_node ───────────────────────────────────────
	server.registerTool(
		"delete_node",
		{
			title: "Delete Node",
			description:
				"Remove a node and all connected edges from a workflow.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				node_id: z.string().describe("The node ID to delete"),
			},
			_meta: uiMeta,
		},
		async (args: { workflow_id: string; node_id: string }) => {
			try {
				const wf = await db.deleteNode(args.workflow_id, args.node_id);
				if (!wf)
					return errorResult(`Workflow "${args.workflow_id}" not found`);
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
	server.registerTool(
		"connect_nodes",
		{
			title: "Connect Nodes",
			description: "Add an edge between two nodes in a workflow.",
			inputSchema: {
				workflow_id: z.string().describe("The workflow ID"),
				source_node_id: z.string().describe("Source node ID"),
				target_node_id: z.string().describe("Target node ID"),
				source_handle: z
					.string()
					.optional()
					.describe("Source handle ID"),
				target_handle: z
					.string()
					.optional()
					.describe("Target handle ID"),
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
				if (!wf)
					return errorResult(`Workflow "${args.workflow_id}" not found`);
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
	server.registerTool(
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
				const wf = await db.disconnectNodes(
					args.workflow_id,
					args.edge_id,
				);
				if (!wf)
					return errorResult(`Workflow "${args.workflow_id}" not found`);
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
	server.registerTool(
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
	server.registerTool(
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
				// Fetch workflow to build execution payload
				const wf = await db.getWorkflow(args.workflow_id);
				if (!wf)
					return errorResult(`Workflow "${args.workflow_id}" not found`);

				const payload = {
					workflowId: wf.id,
					definition: {
						nodes: wf.nodes,
						edges: wf.edges,
					},
					triggerData: args.trigger_data ?? {},
					integrations: {},
				};

				const resp = await fetch(
					`${ORCHESTRATOR_URL}/api/v2/workflows`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(payload),
					},
				);

				if (!resp.ok) {
					const text = await resp.text();
					return errorResult(
						`Orchestrator returned ${resp.status}: ${text}`,
					);
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

	return tools;
}
