import { tool } from "ai";
import { z } from "zod";

export type CanvasToolResult = {
	op:
		| "addNode"
		| "updateNodeData"
		| "deleteNode"
		| "addEdge"
		| "deleteEdge"
		| "setName"
		| "selectNode"
		| "clearWorkflow"
		| "autoArrange"
		| "presentOptions";
	payload: Record<string, unknown>;
	summary: string;
};

const nodeTypeEnum = z.enum([
	"action",
	"loop-until",
	"if-else",
	"set-state",
	"transform",
	"note",
	"timer",
	"approval-gate",
	"publish-event",
	"sub-workflow",
]);

export function getCanvasTools() {
	return {
		add_node: tool({
			description:
				"Add a new node to the workflow canvas. Position nodes 250px apart. The trigger node already exists — do not add a trigger.",
			inputSchema: z.object({
				id: z
					.string()
					.describe("Unique node ID (e.g. 'http-request-1', 'check-status')"),
				type: nodeTypeEnum.describe("The node type"),
				label: z.string().describe("Human-readable label"),
				description: z
					.string()
					.optional()
					.describe("Optional node description"),
				position: z
					.object({
						x: z.number(),
						y: z.number(),
					})
					.describe(
						"Canvas position. Start at x:350 y:200. Space 250px horizontally for sequential nodes, 250px vertically for branches.",
					),
				config: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						"Node configuration object. For action nodes, must include 'actionType' (e.g. 'system/http-request'). See system prompt for config keys per node type.",
					),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				return {
					op: "addNode",
					payload: {
						id: args.id,
						type: args.type,
						position: args.position,
						data: {
							label: args.label,
							description: args.description,
							type: args.type,
							config: args.config || {},
							status: "idle",
						},
					},
					summary: `Added ${args.type} node "${args.label}"`,
				};
			},
		}),

		update_node: tool({
			description:
				"Update an existing node's label, description, or config fields. Use this to fill in form fields on a node (e.g. set HTTP method, endpoint URL, condition operator).",
			inputSchema: z.object({
				id: z.string().describe("The node ID to update"),
				label: z.string().optional().describe("New label"),
				description: z.string().optional().describe("New description"),
				config: z
					.record(z.string(), z.unknown())
					.optional()
					.describe(
						"Config fields to merge (not replace). E.g. { httpMethod: 'POST', endpoint: 'https://...' }",
					),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				const data: Record<string, unknown> = {};
				if (args.label !== undefined) data.label = args.label;
				if (args.description !== undefined) data.description = args.description;
				if (args.config !== undefined) data.config = args.config;

				return {
					op: "updateNodeData",
					payload: { id: args.id, data },
					summary: `Updated node "${args.id}"${args.label ? ` → "${args.label}"` : ""}`,
				};
			},
		}),

		delete_node: tool({
			description:
				"Remove a node from the canvas. Cannot delete the trigger node. Also removes connected edges.",
			inputSchema: z.object({
				id: z.string().describe("The node ID to delete"),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				return {
					op: "deleteNode",
					payload: { id: args.id },
					summary: `Deleted node "${args.id}"`,
				};
			},
		}),

		connect_nodes: tool({
			description:
				"Add an edge connecting two nodes. For if-else nodes, set sourceHandle to 'true' or 'false' for the branch.",
			inputSchema: z.object({
				source: z.string().describe("Source node ID"),
				target: z.string().describe("Target node ID"),
				sourceHandle: z
					.string()
					.optional()
					.describe("Source handle ('true' or 'false' for if-else branches)"),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				const edgeId = `edge-${args.source}-${args.target}${args.sourceHandle ? `-${args.sourceHandle}` : ""}`;
				return {
					op: "addEdge",
					payload: {
						id: edgeId,
						source: args.source,
						target: args.target,
						sourceHandle: args.sourceHandle || null,
						type: "animated",
					},
					summary: `Connected "${args.source}" → "${args.target}"${args.sourceHandle ? ` (${args.sourceHandle})` : ""}`,
				};
			},
		}),

		disconnect_nodes: tool({
			description: "Remove an edge between two nodes.",
			inputSchema: z.object({
				edgeId: z
					.string()
					.describe(
						"The edge ID to remove. Edge IDs follow the pattern edge-{source}-{target}.",
					),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				return {
					op: "deleteEdge",
					payload: { edgeId: args.edgeId },
					summary: `Removed edge "${args.edgeId}"`,
				};
			},
		}),

		set_workflow_name: tool({
			description: "Set or change the workflow name.",
			inputSchema: z.object({
				name: z.string().describe("The new workflow name"),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				return {
					op: "setName",
					payload: { name: args.name },
					summary: `Renamed workflow to "${args.name}"`,
				};
			},
		}),

		clear_workflow: tool({
			description:
				"Remove all non-trigger nodes and edges, starting the workflow fresh. The trigger node is preserved.",
			inputSchema: z.object({}),
			execute: async (): Promise<CanvasToolResult> => {
				return {
					op: "clearWorkflow",
					payload: {},
					summary: "Cleared workflow",
				};
			},
		}),

		auto_arrange: tool({
			description:
				"Auto-layout all nodes using the dagre algorithm for a clean, readable layout. Use after adding multiple nodes.",
			inputSchema: z.object({}),
			execute: async (): Promise<CanvasToolResult> => {
				return {
					op: "autoArrange",
					payload: {},
					summary: "Auto-arranged nodes",
				};
			},
		}),

		select_node: tool({
			description:
				"Select and focus a node on the canvas to draw the user's attention to it.",
			inputSchema: z.object({
				id: z.string().describe("The node ID to select"),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				return {
					op: "selectNode",
					payload: { nodeId: args.id },
					summary: `Selected node "${args.id}"`,
				};
			},
		}),

		present_options: tool({
			description:
				"Present clickable option chips to the user. Use this instead of asking open-ended questions when you need the user to choose between specific options.",
			inputSchema: z.object({
				question: z.string().describe("The question to ask the user"),
				options: z
					.array(
						z.object({
							label: z.string().describe("Short label shown on the button"),
							value: z
								.string()
								.describe("Value sent as user message when clicked"),
							description: z
								.string()
								.optional()
								.describe("Optional description shown below"),
						}),
					)
					.describe("The options to present"),
			}),
			execute: async (args): Promise<CanvasToolResult> => {
				return {
					op: "presentOptions",
					payload: {
						question: args.question,
						options: args.options,
					},
					summary: `Presented ${args.options.length} options`,
				};
			},
		}),
	};
}
