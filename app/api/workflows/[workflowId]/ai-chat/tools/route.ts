import {
	convertToModelMessages,
	generateId,
	streamText,
	stepCountIs,
	type UIMessage,
} from "ai";
import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import {
	workflowAiToolMessages,
	workflowExecutionLogs,
	workflowExecutions,
	workflows,
} from "@/lib/db/schema";
import { getCanvasTools } from "@/lib/ai/canvas-tools";
import { getAiModel } from "@/lib/ai/workflow-generation";
import { buildRelevantActionListPrompt } from "@/lib/ai/action-list-prompt";
import { loadInstalledWorkflowSpecCatalog } from "@/lib/workflow-spec/catalog-server";
import { buildWorkflowContextAvailability } from "@/lib/workflow-validation/context-availability";
import { flattenConfigFields } from "@/lib/actions/utils";
import type { WorkflowAiMentionRef } from "@/lib/ai/workflow-ai-tools";
import { isWorkflowAiToolMessagesTableMissing } from "@/lib/db/workflow-ai-tool-messages";
import { redactSensitiveData } from "@/lib/utils/redact";
import type { WorkflowSpecCatalog } from "@/lib/workflow-spec/catalog";

type CanvasNode = {
	id: string;
	type?: string;
	position?: { x: number; y: number };
	data?: {
		label?: string;
		type?: string;
		description?: string;
		config?: Record<string, unknown>;
	};
};

type CanvasEdge = {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
};

type ExecutionLogSummary = {
	nodeId: string;
	nodeName: string;
	status: "pending" | "running" | "success" | "error";
	actionType?: string | null;
	outputPreview?: string;
};

type CanvasState = {
	nodes: CanvasNode[];
	edges: CanvasEdge[];
	name: string;
	selectedNodeId?: string | null;
	selectedNodeIds?: string[];
	engineType?: string;
	hasUnsavedChanges?: boolean;
	isExecuting?: boolean;
	executionLogs?: ExecutionLogSummary[];
	currentRunningNodeId?: string | null;
	daprPhase?: string | null;
	daprMessage?: string | null;
	approvalEventName?: string | null;
	approvalExecutionId?: string | null;
};

const MAX_MENTION_REFS = 8;
const MAX_EXECUTION_LOG_PREVIEW = 600;
const MAX_STORED_PART_TEXT = 4000;
const MAX_STORED_PARTS = 48;

function truncate(text: string, maxChars: number): string {
	return text.length > maxChars
		? `${text.slice(0, maxChars)}...[truncated]`
		: text;
}

function safeJsonPreview(
	value: unknown,
	maxChars = MAX_EXECUTION_LOG_PREVIEW,
): string {
	if (value === null || value === undefined) {
		return "";
	}
	try {
		const serialized =
			typeof value === "string"
				? value
				: JSON.stringify(redactSensitiveData(value));
		return truncate(serialized, maxChars);
	} catch {
		return "";
	}
}

function extractTextFromParts(parts: unknown): string {
	if (!Array.isArray(parts)) {
		return "";
	}

	const textSegments = parts
		.map((part) => {
			if (!part || typeof part !== "object") {
				return "";
			}
			const p = part as Record<string, unknown>;
			return typeof p.text === "string" ? p.text : "";
		})
		.filter(Boolean);

	return textSegments.join("\n\n").trim();
}

function normalizeRole(value: unknown): "user" | "assistant" | "system" | null {
	return value === "user" || value === "assistant" || value === "system"
		? value
		: null;
}

function sanitizeStoredParts(parts: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(parts)) {
		return [];
	}

	const sanitized: Array<Record<string, unknown>> = [];

	for (const rawPart of parts.slice(0, MAX_STORED_PARTS)) {
		if (!rawPart || typeof rawPart !== "object") {
			continue;
		}

		const part = rawPart as Record<string, unknown>;
		const type = typeof part.type === "string" ? part.type : "unknown";

		if (type === "text") {
			sanitized.push({
				type,
				text: truncate(
					typeof part.text === "string" ? part.text : "",
					MAX_STORED_PART_TEXT,
				),
			});
			continue;
		}

		if (type.startsWith("tool-") || type === "dynamic-tool") {
			sanitized.push({
				type,
				toolCallId:
					typeof part.toolCallId === "string" ? part.toolCallId : undefined,
				state: typeof part.state === "string" ? part.state : undefined,
				output:
					part.output && typeof part.output === "object"
						? redactSensitiveData(part.output)
						: undefined,
			});
			continue;
		}

		sanitized.push({ type });
	}

	return sanitized;
}

function sanitizeMentionRefs(value: unknown): WorkflowAiMentionRef[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const refs: WorkflowAiMentionRef[] = [];
	for (const item of value.slice(0, MAX_MENTION_REFS)) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const mention = item as Record<string, unknown>;
		const id = typeof mention.id === "string" ? mention.id : "";
		const label = typeof mention.label === "string" ? mention.label : "";
		const description =
			typeof mention.description === "string" ? mention.description : undefined;
		if (!id || !label) {
			continue;
		}

		if (mention.type === "node" && typeof mention.nodeId === "string") {
			refs.push({
				id,
				type: "node",
				nodeId: mention.nodeId,
				label,
				description,
			});
			continue;
		}

		if (mention.type === "action" && typeof mention.actionType === "string") {
			refs.push({
				id,
				type: "action",
				actionType: mention.actionType,
				label,
				description,
			});
			continue;
		}

		if (
			mention.type === "execution" &&
			typeof mention.executionId === "string"
		) {
			refs.push({
				id,
				type: "execution",
				executionId: mention.executionId,
				label,
				description,
			});
		}
	}

	return refs;
}

/**
 * Config schema metadata for non-action node types.
 * Action nodes get their metadata from the catalog; these cover the rest.
 */
const NODE_TYPE_CONFIG_SCHEMAS: Record<
	string,
	{
		description: string;
		fields: {
			key: string;
			label: string;
			type: string;
			required?: boolean;
			hint?: string;
		}[];
	}
> = {
	trigger: {
		description: "Workflow start node — receives initial input",
		fields: [],
	},
	"if-else": {
		description:
			"Conditional branch — routes to true/false paths based on comparison",
		fields: [
			{
				key: "operator",
				label: "Operator",
				type: "select",
				required: true,
				hint: "eq, neq, gt, gte, lt, lte, contains, not_contains, is_empty, is_not_empty",
			},
			{
				key: "left",
				label: "Left operand",
				type: "template-input",
				required: true,
			},
			{ key: "right", label: "Right operand", type: "template-input" },
		],
	},
	"loop-until": {
		description:
			"Repeat a sub-flow until a condition is met or max iterations reached",
		fields: [
			{
				key: "loopStartNodeId",
				label: "Loop start node",
				type: "select",
				required: true,
			},
			{
				key: "maxIterations",
				label: "Max iterations",
				type: "number",
				hint: "Default 10",
			},
			{ key: "operator", label: "Operator", type: "select", required: true },
			{
				key: "left",
				label: "Left operand",
				type: "template-input",
				required: true,
			},
			{ key: "right", label: "Right operand", type: "template-input" },
		],
	},
	"set-state": {
		description:
			"Set a workflow variable that can be referenced via {{state.key}}",
		fields: [
			{
				key: "entries",
				label: "Key/value entries",
				type: "array",
				required: true,
				hint: "Each entry: { key, value }",
			},
		],
	},
	transform: {
		description: "Build structured JSON output using a template",
		fields: [
			{
				key: "templateJson",
				label: "Template JSON",
				type: "template-textarea",
				required: true,
			},
		],
	},
	timer: {
		description: "Delay execution for a specified duration",
		fields: [
			{
				key: "delaySeconds",
				label: "Delay (seconds)",
				type: "number",
				required: true,
			},
		],
	},
	"approval-gate": {
		description: "Pause workflow and wait for an external approval event",
		fields: [
			{ key: "eventName", label: "Event name", type: "text", required: true },
			{ key: "timeoutSeconds", label: "Timeout (seconds)", type: "number" },
		],
	},
	"publish-event": {
		description: "Publish a message to a pub/sub topic",
		fields: [
			{ key: "topic", label: "Topic", type: "text", required: true },
			{ key: "data", label: "Data", type: "template-textarea", required: true },
		],
	},
	note: {
		description: "Non-executing annotation for documentation",
		fields: [{ key: "text", label: "Note text", type: "text" }],
	},
	"sub-workflow": {
		description: "Execute another saved workflow as a child step",
		fields: [
			{
				key: "workflowId",
				label: "Workflow ID",
				type: "select",
				required: true,
			},
			{
				key: "inputMapping",
				label: "Input mapping (JSON template)",
				type: "template-textarea",
			},
		],
	},
};

function buildSelectedNodeContext(
	selectedNode: CanvasNode,
	canvasState: CanvasState,
	catalog: WorkflowSpecCatalog,
): string {
	const lines: string[] = [];
	const nodeType = selectedNode.data?.type || selectedNode.type || "unknown";
	const label = selectedNode.data?.label || "Unlabeled";
	const config = (selectedNode.data?.config ?? {}) as Record<string, unknown>;
	const actionType = config.actionType as string | undefined;

	// A. Basic identification
	lines.push(`SELECTED NODE:`);
	lines.push(`"${label}" (id="${selectedNode.id}", type=${nodeType})`);
	lines.push(
		`When they say "this node", "it", "configure it", they mean this node.`,
	);

	// B. Node description
	if (selectedNode.data?.description) {
		lines.push(`Description: ${selectedNode.data.description}`);
	}

	// C. Action/node-type metadata
	if (nodeType === "action" && actionType) {
		const actionDef = catalog.actionsById.get(actionType);
		if (actionDef) {
			lines.push(``);
			lines.push(`Action: ${actionType} — "${actionDef.description}"`);

			// Config fields
			const flat = flattenConfigFields(actionDef.configFields);
			if (flat.length > 0) {
				lines.push(`Config fields:`);
				for (const f of flat) {
					const parts = [`  - ${f.key} (${f.type}`];
					if (f.required) parts[0] += ", required";
					parts[0] += `)`;
					if (f.label !== f.key) parts[0] += `: ${f.label}`;
					if (f.showWhen)
						parts.push(
							`    [shown when ${f.showWhen.field}="${f.showWhen.equals}"]`,
						);
					if (f.options && f.options.length <= 8) {
						parts.push(
							`    Options: ${f.options.map((o) => o.value).join(", ")}`,
						);
					}
					if (f.placeholder) parts.push(`    Hint: ${f.placeholder}`);
					else if (f.example) parts.push(`    Example: ${f.example}`);
					lines.push(parts.join("\n"));
				}
			}

			// Output fields
			if (actionDef.outputFields && actionDef.outputFields.length > 0) {
				lines.push(`Output fields:`);
				for (const o of actionDef.outputFields) {
					lines.push(`  - ${o.field}: ${o.description}`);
				}
			}
		} else {
			lines.push(`Action: ${actionType} (no catalog metadata available)`);
		}
	} else if (nodeType !== "action") {
		const schema = NODE_TYPE_CONFIG_SCHEMAS[nodeType];
		if (schema) {
			lines.push(``);
			lines.push(`Node type: ${nodeType} — "${schema.description}"`);
			if (schema.fields.length > 0) {
				lines.push(`Config fields:`);
				for (const f of schema.fields) {
					let line = `  - ${f.key} (${f.type}`;
					if (f.required) line += ", required";
					line += `)`;
					if (f.label !== f.key) line += `: ${f.label}`;
					if (f.hint) line += `. Hint: ${f.hint}`;
					lines.push(line);
				}
			}
		}
	}

	// D. Current config
	lines.push(``);
	lines.push(`Current config: ${JSON.stringify(config)}`);

	// E. Upstream context
	try {
		const ctxMap = buildWorkflowContextAvailability(
			canvasState.nodes as any,
			canvasState.edges as any,
		);
		const ctx = ctxMap[selectedNode.id];
		if (ctx) {
			const upstream = ctx.upstreamNodes.slice(0, 8);
			if (upstream.length > 0) {
				lines.push(``);
				lines.push(
					`Upstream context (referenceable via {{@nodeId:Label.field}}):`,
				);
				for (const u of upstream) {
					let line = `  - ${u.nodeId} "${u.nodeLabel}" (${u.nodeType}) [${u.availability}]`;
					// Look up output fields for upstream action nodes
					const upNode = canvasState.nodes.find((n) => n.id === u.nodeId);
					const upActionType = (
						upNode?.data?.config as Record<string, unknown> | undefined
					)?.actionType as string | undefined;
					if (upActionType) {
						const upDef = catalog.actionsById.get(upActionType);
						if (upDef?.outputFields && upDef.outputFields.length > 0) {
							const fields = upDef.outputFields
								.slice(0, 5)
								.map((o) => o.field)
								.join(", ");
							line += ` → outputs: ${fields}`;
						}
					}
					lines.push(line);
				}
			}

			if (ctx.stateKeys.length > 0) {
				lines.push(
					`State keys: ${ctx.stateKeys.map((k) => `${k} (use {{state.${k}}})`).join(", ")}`,
				);
			}
		}
	} catch {
		// Graceful degradation if context computation fails
	}

	// F. Downstream nodes
	const downstreamIds = canvasState.edges
		.filter((e) => e.source === selectedNode.id)
		.map((e) => e.target);
	if (downstreamIds.length > 0) {
		const downstreamNodes = downstreamIds
			.map((id) => canvasState.nodes.find((n) => n.id === id))
			.filter(Boolean)
			.map(
				(n) =>
					`  - ${n!.id} "${n!.data?.label || "Unlabeled"}" (${n!.data?.type || n!.type || "unknown"})`,
			);
		if (downstreamNodes.length > 0) {
			lines.push(``);
			lines.push(`Downstream nodes:`);
			lines.push(...downstreamNodes);
		}
	}

	return lines.join("\n");
}

function buildCanvasSystemPrompt(
	canvasState: CanvasState,
	actionListPrompt: string,
	catalog: WorkflowSpecCatalog,
): string {
	const nodesList = canvasState.nodes
		.map((n) => {
			const parts = [
				`- id="${n.id}" type=${n.data?.type || n.type || "unknown"} label="${n.data?.label || "Unlabeled"}"`,
				`pos=(${n.position?.x ?? 0}, ${n.position?.y ?? 0})`,
			];
			if (n.data?.config && Object.keys(n.data.config).length > 0) {
				parts.push(`config=${JSON.stringify(n.data.config)}`);
			}
			return parts.join(" ");
		})
		.join("\n");

	const edgesList = canvasState.edges
		.map(
			(e) =>
				`- ${e.id}: ${e.source} → ${e.target}${e.sourceHandle ? ` (handle: ${e.sourceHandle})` : ""}`,
		)
		.join("\n");

	// Build conditional context sections
	const contextSections: string[] = [];

	// Selected node details (enriched with catalog metadata + upstream context)
	if (canvasState.selectedNodeIds && canvasState.selectedNodeIds.length > 1) {
		// Multiple nodes selected — build context for each
		const selectedNodes = canvasState.selectedNodeIds
			.map((id) => canvasState.nodes.find((n) => n.id === id))
			.filter(Boolean) as CanvasNode[];
		if (selectedNodes.length > 0) {
			contextSections.push(
				`MULTIPLE NODES SELECTED (${selectedNodes.length}):\nWhen the user says "these nodes", "selected nodes", or "them", they mean these nodes.\n`,
			);
			for (const node of selectedNodes) {
				contextSections.push(
					buildSelectedNodeContext(node, canvasState, catalog),
				);
			}
		}
	} else if (canvasState.selectedNodeId) {
		const selectedNode = canvasState.nodes.find(
			(n) => n.id === canvasState.selectedNodeId,
		);
		if (selectedNode) {
			contextSections.push(
				buildSelectedNodeContext(selectedNode, canvasState, catalog),
			);
		}
	}

	// Unsaved changes warning
	if (canvasState.hasUnsavedChanges) {
		contextSections.push(
			"NOTE: The workflow has unsaved changes. Remind the user to save before executing.",
		);
	}

	// Execution in progress guard
	if (canvasState.isExecuting) {
		const runningNote = canvasState.currentRunningNodeId
			? `\nCurrently executing node: "${canvasState.currentRunningNodeId}"`
			: "";
		contextSections.push(
			`EXECUTION IN PROGRESS: Do not suggest structural changes while the workflow is running.${runningNote}`,
		);
	}

	// Last execution results
	if (canvasState.executionLogs && canvasState.executionLogs.length > 0) {
		const logLines = canvasState.executionLogs.map((log) => {
			const parts = [
				`- node="${log.nodeName}" (${log.nodeId})`,
				`status=${log.status}`,
			];
			if (log.actionType) parts.push(`action=${log.actionType}`);
			if (log.outputPreview) parts.push(`output: ${log.outputPreview}`);
			return parts.join(" ");
		});
		contextSections.push(
			`LAST EXECUTION RESULTS:\n${logLines.join("\n")}\nUse these results to help debug failures or explain outputs.`,
		);
	}

	// Dapr execution phase
	if (canvasState.daprPhase) {
		const phaseMsg = canvasState.daprMessage
			? `${canvasState.daprPhase} — ${canvasState.daprMessage}`
			: canvasState.daprPhase;
		contextSections.push(`DAPR EXECUTION PHASE: ${phaseMsg}`);
	}

	// Approval pending
	if (canvasState.approvalEventName) {
		contextSections.push(
			`APPROVAL PENDING: The workflow is waiting for approval on event "${canvasState.approvalEventName}".${canvasState.approvalExecutionId ? ` Execution ID: ${canvasState.approvalExecutionId}` : ""}`,
		);
	}

	const conditionalContext =
		contextSections.length > 0 ? "\n\n" + contextSections.join("\n\n") : "";

	const engineLabel = canvasState.engineType || "dapr";

	return `You are a workflow automation assistant that modifies workflows using tools.

CURRENT WORKFLOW: "${canvasState.name}"
ENGINE: ${engineLabel}

CURRENT NODES:
${nodesList || "(no nodes)"}

CURRENT EDGES:
${edgesList || "(no edges)"}
${conditionalContext}

AVAILABLE TOOLS:
- add_node: Add a new node to the canvas
- update_node: Update a node's label, description, or config fields
- delete_node: Remove a node (not the trigger)
- connect_nodes: Add an edge between two nodes
- disconnect_nodes: Remove an edge
- set_workflow_name: Change the workflow name
- clear_workflow: Clear all non-trigger nodes and start fresh
- auto_arrange: Auto-layout nodes for a clean, readable layout
- select_node: Select a node to focus user attention on it
- present_options: Present clickable choices when you need user input

NODE TYPES:
- action: Executes a function (requires actionType in config)
- loop-until: Repeat until condition met (config: loopStartNodeId, maxIterations, operator, left, right)
- if-else: Conditional branch (config: operator, left, right). Edges use sourceHandle "true"/"false"
- set-state: Set a workflow variable (config: key, value)
- transform: Build structured output (config: templateJson)
- note: Non-executing annotation (config: text)
- timer: Delay execution (config: delaySeconds)
- approval-gate: Wait for external event (config: eventName, timeoutSeconds)
- publish-event: Publish to pub/sub (config: topic, data)

ACTION NODE CONFIG:
For action nodes, set config.actionType to the action slug. Key action types:
- system/http-request: httpMethod, endpoint, httpHeaders, httpBody
- system/database-query: dbQuery
- system/condition: operator, left, right

AVAILABLE ACTIONS:
${actionListPrompt}

POSITIONING RULES:
- Trigger node is typically at (100, 200)
- Space nodes 250px apart horizontally for sequential flow
- Space nodes 250px apart vertically for parallel branches
- Check existing node positions to avoid overlaps

TEMPLATE REFERENCES:
- Reference node output: {{@nodeId:Label.field}}
- Reference state: {{state.key}}

EDGE RULES:
- Every workflow must start with the trigger node
- Every non-trigger node must be reachable from the trigger
- For if-else: use sourceHandle "true" or "false"
- Always connect new nodes to the workflow after adding them

COLLABORATION GUIDELINES:
- When you need the user to choose between options (action types, node configurations, branching strategies), use present_options instead of asking open-ended questions
- After adding multiple nodes, use auto_arrange to clean up layout
- Use select_node to highlight nodes being discussed

GUIDELINES:
- Use the current canvas state above to understand what exists
- Only add/modify/remove what the user asks for
- After adding nodes, ALWAYS add edges to connect them
- When the user asks to "fill in" or "configure" a node, use update_node
- Keep explanations brief in your text responses`;
}

async function persistToolMessage(params: {
	workflowId: string;
	userId: string;
	message: UIMessage;
	mentions?: WorkflowAiMentionRef[];
}) {
	const role = normalizeRole(params.message.role);
	if (!role) {
		return;
	}

	const sanitizedParts = sanitizeStoredParts(params.message.parts);
	const textContent = extractTextFromParts(sanitizedParts);
	const messageId = params.message.id || generateId();

	try {
		await db
			.insert(workflowAiToolMessages)
			.values({
				workflowId: params.workflowId,
				userId: params.userId,
				messageId,
				role,
				parts:
					sanitizedParts.length > 0
						? sanitizedParts
						: [{ type: "text", text: textContent }],
				textContent,
				mentions: params.mentions
					? (params.mentions as Array<Record<string, unknown>>)
					: null,
			})
			.onConflictDoNothing({
				target: [
					workflowAiToolMessages.workflowId,
					workflowAiToolMessages.userId,
					workflowAiToolMessages.messageId,
				],
			});
	} catch (error) {
		if (!isWorkflowAiToolMessagesTableMissing(error)) {
			throw error;
		}
	}
}

async function loadExecutionSummaryBlock(
	executionId: string,
	workflowId: string,
	userId: string,
	title: string,
): Promise<string | null> {
	const execution = await db.query.workflowExecutions.findFirst({
		where: and(
			eq(workflowExecutions.id, executionId),
			eq(workflowExecutions.workflowId, workflowId),
			eq(workflowExecutions.userId, userId),
		),
	});

	if (!execution) {
		return null;
	}

	const logs = await db.query.workflowExecutionLogs.findMany({
		where: eq(workflowExecutionLogs.executionId, execution.id),
		orderBy: [desc(workflowExecutionLogs.timestamp)],
		limit: 12,
	});

	const failedLogs = logs.filter((log) => log.status === "error").slice(0, 5);
	const runningLogs = logs
		.filter((log) => log.status === "running")
		.slice(0, 3);
	const recentLogs = logs.slice(0, 5);

	const lines: string[] = [
		`${title}:`,
		`- Execution ID: ${execution.id}`,
		`- Status: ${execution.status}`,
		`- Started At: ${execution.startedAt.toISOString()}`,
	];

	if (execution.completedAt) {
		lines.push(`- Completed At: ${execution.completedAt.toISOString()}`);
	}

	if (execution.phase) {
		lines.push(`- Phase: ${execution.phase}`);
	}
	if (typeof execution.progress === "number") {
		lines.push(`- Progress: ${execution.progress}%`);
	}
	if (execution.error) {
		lines.push(`- Workflow Error: ${truncate(execution.error, 280)}`);
	}

	if (failedLogs.length > 0) {
		lines.push(`- Failed Nodes:`);
		for (const log of failedLogs) {
			const detail =
				log.error ||
				safeJsonPreview(log.output) ||
				safeJsonPreview(log.input) ||
				"No error details";
			lines.push(
				`  - ${log.nodeName} (${log.nodeId}) [${log.activityName || log.nodeType}]: ${truncate(detail, 240)}`,
			);
		}
	} else if (runningLogs.length > 0) {
		lines.push(`- In-flight Nodes:`);
		for (const log of runningLogs) {
			lines.push(
				`  - ${log.nodeName} (${log.nodeId}) [${log.activityName || log.nodeType}]`,
			);
		}
	} else if (recentLogs.length > 0) {
		lines.push(`- Recent Node Results:`);
		for (const log of recentLogs) {
			const detail = safeJsonPreview(log.output);
			lines.push(
				`  - ${log.nodeName} (${log.nodeId}) status=${log.status}${detail ? ` output=${detail}` : ""}`,
			);
		}
	}

	return lines.join("\n");
}

async function loadLatestExecutionSummaryBlock(
	workflowId: string,
	userId: string,
): Promise<string | null> {
	const latest = await db.query.workflowExecutions.findFirst({
		where: and(
			eq(workflowExecutions.workflowId, workflowId),
			eq(workflowExecutions.userId, userId),
		),
		orderBy: [desc(workflowExecutions.startedAt)],
	});

	if (!latest) {
		return null;
	}

	return loadExecutionSummaryBlock(
		latest.id,
		workflowId,
		userId,
		"LATEST EXECUTION SUMMARY",
	);
}

function buildActionMentionContext(
	actionType: string,
	catalog: WorkflowSpecCatalog,
): string | null {
	const actionDef = catalog.actionsById.get(actionType);
	if (!actionDef) {
		return null;
	}

	const lines = [
		`MENTIONED ACTION TEMPLATE: ${actionType}`,
		`- Description: ${actionDef.description || "No description available"}`,
	];

	const flat = flattenConfigFields(actionDef.configFields).slice(0, 14);
	if (flat.length > 0) {
		lines.push("- Key Config Fields:");
		for (const field of flat) {
			const required = field.required ? ", required" : "";
			lines.push(`  - ${field.key} (${field.type}${required})`);
		}
	}

	if (actionDef.outputFields?.length) {
		lines.push("- Output Fields:");
		for (const output of actionDef.outputFields.slice(0, 10)) {
			lines.push(`  - ${output.field}: ${output.description}`);
		}
	}

	return lines.join("\n");
}

async function buildMentionContextSections(params: {
	mentionRefs: WorkflowAiMentionRef[];
	state: CanvasState;
	catalog: WorkflowSpecCatalog;
	workflowId: string;
	userId: string;
}): Promise<string[]> {
	const sections: string[] = [];
	for (const ref of params.mentionRefs.slice(0, MAX_MENTION_REFS)) {
		if (ref.type === "node") {
			const node = params.state.nodes.find(
				(candidate) => candidate.id === ref.nodeId,
			);
			if (!node) {
				continue;
			}
			sections.push(
				`MENTIONED NODE: @${ref.label}\n${buildSelectedNodeContext(node, params.state, params.catalog)}`,
			);
			continue;
		}

		if (ref.type === "action") {
			const actionContext = buildActionMentionContext(
				ref.actionType,
				params.catalog,
			);
			if (actionContext) {
				sections.push(actionContext);
			}
			continue;
		}

		const executionSummary = await loadExecutionSummaryBlock(
			ref.executionId,
			params.workflowId,
			params.userId,
			`MENTIONED EXECUTION: @${ref.label}`,
		);
		if (executionSummary) {
			sections.push(executionSummary);
		}
	}

	return sections;
}

export async function POST(
	request: Request,
	context: { params: Promise<{ workflowId: string }> },
) {
	try {
		const { workflowId } = await context.params;
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const workflow = await db.query.workflows.findFirst({
			where: and(
				eq(workflows.id, workflowId),
				eq(workflows.userId, session.user.id),
			),
		});

		if (!workflow) {
			return NextResponse.json(
				{ error: "Workflow not found" },
				{ status: 404 },
			);
		}

		const body = await request.json();
		const uiMessages = Array.isArray(body?.messages)
			? (body.messages as UIMessage[])
			: null;
		const canvasState = body?.canvasState;
		const mentionRefs = sanitizeMentionRefs(body?.mentionRefs);

		if (!uiMessages) {
			return NextResponse.json(
				{ error: "messages array is required" },
				{ status: 400 },
			);
		}

		const state: CanvasState = canvasState || {
			nodes: [],
			edges: [],
			name: workflow.name || "Untitled",
		};

		// Build action list for the system prompt
		const catalog = await loadInstalledWorkflowSpecCatalog();
		const userText = uiMessages
			.filter((m: { role: string }) => m.role === "user")
			.map(
				(m: { parts?: Array<{ type: string; text?: string }> }) =>
					m.parts
						?.filter((p) => p.type === "text")
						.map((p) => p.text)
						.join(" ") || "",
			)
			.join(" ");

		const actionListPrompt = buildRelevantActionListPrompt({
			catalog,
			prompt: userText,
			limit: 80,
		});

		const latestExecutionSummary = await loadLatestExecutionSummaryBlock(
			workflowId,
			session.user.id,
		);
		const mentionContextSections = await buildMentionContextSections({
			mentionRefs,
			state,
			catalog,
			workflowId,
			userId: session.user.id,
		});
		const additionalSections = [
			latestExecutionSummary,
			...mentionContextSections,
		].filter((section): section is string => Boolean(section));

		let systemPrompt = buildCanvasSystemPrompt(
			state,
			actionListPrompt,
			catalog,
		);
		if (additionalSections.length > 0) {
			systemPrompt += `\n\nADDITIONAL CONTEXT:\n${additionalSections.join("\n\n")}`;
		}

		const latestUserMessage = [...uiMessages]
			.reverse()
			.find((message) => message.role === "user");
		if (latestUserMessage) {
			await persistToolMessage({
				workflowId,
				userId: session.user.id,
				message: latestUserMessage,
				mentions: mentionRefs,
			});
		}

		// Convert UIMessage[] to ModelMessage[]
		const modelMessages = await convertToModelMessages(uiMessages);

		const result = streamText({
			model: await getAiModel({ anthropicFallback: "claude-sonnet-4-6" }),
			system: systemPrompt,
			messages: modelMessages,
			tools: getCanvasTools(),
			stopWhen: stepCountIs(5),
		});

		return result.toUIMessageStreamResponse({
			generateMessageId: generateId,
			onFinish: async ({ responseMessage }) => {
				if (!responseMessage) {
					return;
				}
				await persistToolMessage({
					workflowId,
					userId: session.user.id,
					message: responseMessage,
				});
			},
		});
	} catch (error) {
		console.error("[ai-chat/tools] API error:", error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to process AI chat tools request",
			},
			{ status: 500 },
		);
	}
}
