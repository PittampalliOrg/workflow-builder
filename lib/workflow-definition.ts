/**
 * Workflow Definition Types
 *
 * Shared types for workflow definitions used by both the Next.js app
 * and the TypeScript orchestrator service. These types define the
 * serializable format for workflows that can be stored and executed.
 */

import type {
	WorkflowEdge,
	WorkflowNode,
	WorkflowNodeType,
} from "./workflow-store";

/**
 * Serialized node format for workflow definitions
 * Contains all the data needed to execute a node in the orchestrator
 */
export type SerializedNode = {
	id: string;
	type: WorkflowNodeType;
	label: string;
	description?: string;
	enabled: boolean;
	position: { x: number; y: number };
	config: Record<string, unknown>;
};

/**
 * Serialized edge format for workflow definitions
 */
export type SerializedEdge = {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
	targetHandle?: string | null;
};

/**
 * Complete workflow definition that can be stored and executed
 */
export type WorkflowDefinition = {
	id: string;
	name: string;
	version: string;
	createdAt: string;
	updatedAt: string;
	nodes: SerializedNode[];
	edges: SerializedEdge[];
	/** Topologically sorted node IDs for execution order */
	executionOrder: string[];
	/** Metadata for the workflow */
	metadata?: {
		description?: string;
		author?: string;
		tags?: string[];
	};
};

/**
 * Input to start a workflow execution
 */
export type WorkflowExecutionInput = {
	/** Workflow definition to execute */
	definition: WorkflowDefinition;
	/** Trigger data that starts the workflow */
	triggerData: Record<string, unknown>;
	/** Optional execution ID (generated if not provided) */
	executionId?: string;
	/** User ID initiating the workflow */
	userId?: string;
	/** Integration credentials map (integrationId -> credentials) */
	integrations?: Record<string, Record<string, string>>;
};

/**
 * Output from a completed workflow execution
 */
export type WorkflowExecutionOutput = {
	success: boolean;
	/** Outputs from each node keyed by node ID */
	outputs: Record<string, unknown>;
	/** Error message if failed */
	error?: string;
	/** Total execution duration in milliseconds */
	durationMs: number;
	/** Final phase of the workflow */
	phase: WorkflowPhase;
};

/**
 * Workflow execution phases
 */
export type WorkflowPhase =
	| "pending"
	| "running"
	| "awaiting_approval"
	| "completed"
	| "failed"
	| "rejected"
	| "timed_out"
	| "cancelled";

/**
 * Status update during workflow execution
 */
export type WorkflowStatusUpdate = {
	workflowId: string;
	executionId: string;
	phase: WorkflowPhase;
	progress: number; // 0-100
	message?: string;
	currentNodeId?: string;
	currentNodeName?: string;
	outputs?: Record<string, unknown>;
};

/**
 * Activity execution request sent to the function-router service
 */
export type ActivityExecutionRequest = {
	activityId: string; // e.g., "slack/send-message"
	executionId: string;
	workflowId: string;
	nodeId: string;
	nodeName: string;
	input: Record<string, unknown>;
	nodeOutputs?: Record<string, { label: string; data: unknown }>;
	connectionExternalId?: string;
};

/**
 * Activity execution result from the function-router service
 */
export type ActivityExecutionResult = {
	success: boolean;
	data?: unknown;
	error?: string;
	durationMs: number;
};

/**
 * Approval gate configuration
 */
export type ApprovalGateConfig = {
	eventName: string;
	timeoutSeconds: number;
	approvers?: string[];
	message?: string;
};

/**
 * Timer configuration
 */
export type TimerConfig = {
	durationSeconds: number;
	label?: string;
};

/**
 * Publish event configuration
 */
export type PublishEventConfig = {
	topic: string;
	eventType: string;
	data?: Record<string, unknown>;
};

// ─── Workflow Definition Generation ─────────────────────────────────────────────

/**
 * Topologically sort nodes based on edge dependencies
 * Returns an array of node IDs in execution order
 */
export function topologicalSort(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
): string[] {
	// Build adjacency list
	const edgesBySource = new Map<string, string[]>();
	const inDegree = new Map<string, number>();

	// Initialize all nodes with 0 in-degree
	for (const node of nodes) {
		inDegree.set(node.id, 0);
		edgesBySource.set(node.id, []);
	}

	// Build graph
	for (const edge of edges) {
		const targets = edgesBySource.get(edge.source) || [];
		targets.push(edge.target);
		edgesBySource.set(edge.source, targets);
		inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
	}

	// Find all nodes with 0 in-degree (start with trigger nodes)
	const queue: string[] = [];
	for (const [nodeId, degree] of inDegree) {
		if (degree === 0) {
			queue.push(nodeId);
		}
	}

	const result: string[] = [];

	while (queue.length > 0) {
		const nodeId = queue.shift()!;
		const node = nodes.find((n) => n.id === nodeId);

		// Skip non-executing nodes in execution order
		if (
			node &&
			node.type !== "trigger" &&
			node.type !== "add" &&
			node.type !== "note"
		) {
			result.push(nodeId);
		}

		// Process neighbors
		const neighbors = edgesBySource.get(nodeId) || [];
		for (const neighbor of neighbors) {
			const newDegree = (inDegree.get(neighbor) || 1) - 1;
			inDegree.set(neighbor, newDegree);
			if (newDegree === 0) {
				queue.push(neighbor);
			}
		}
	}

	return result;
}

/**
 * Serialize a WorkflowNode to SerializedNode format
 */
function serializeNode(node: WorkflowNode): SerializedNode {
	return {
		id: node.id,
		type: node.data.type,
		label: node.data.label,
		description: node.data.description,
		enabled: node.data.enabled !== false, // Default to true
		position: node.position,
		config: node.data.config || {},
	};
}

/**
 * Serialize a WorkflowEdge to SerializedEdge format
 */
function serializeEdge(edge: WorkflowEdge): SerializedEdge {
	return {
		id: edge.id,
		source: edge.source,
		target: edge.target,
		sourceHandle: edge.sourceHandle,
		targetHandle: edge.targetHandle,
	};
}

/**
 * Generate a complete WorkflowDefinition from nodes and edges
 * This is the JSON format used by the TypeScript orchestrator
 */
export function generateWorkflowDefinition(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	workflowId: string,
	workflowName?: string,
	metadata?: WorkflowDefinition["metadata"],
): WorkflowDefinition {
	const now = new Date().toISOString();

	// Filter out 'add' nodes (UI placeholder nodes)
	const executableNodes = nodes.filter((n) => n.type !== "add");

	// Serialize nodes and edges
	const serializedNodes = executableNodes.map(serializeNode);
	const serializedEdges = edges
		.filter(
			(e) =>
				executableNodes.some((n) => n.id === e.source) &&
				executableNodes.some((n) => n.id === e.target),
		)
		.map(serializeEdge);

	// Get execution order
	const executionOrder = topologicalSort(executableNodes, edges);

	return {
		id: workflowId,
		name: workflowName || `workflow-${workflowId}`,
		version: "1.0.0",
		createdAt: now,
		updatedAt: now,
		nodes: serializedNodes,
		edges: serializedEdges,
		executionOrder,
		metadata,
	};
}
