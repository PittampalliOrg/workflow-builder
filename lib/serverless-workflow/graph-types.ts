/**
 * Graph types for the visual editor.
 *
 * These types bridge CNCF Serverless Workflow 1.0 tasks
 * to @xyflow/react nodes and edges.
 */

import type { TaskType } from "./types";

// ---------------------------------------------------------------------------
// Node types for the visual editor
// ---------------------------------------------------------------------------

/**
 * All visual node types in the editor.
 * Maps 1:1 to SW 1.0 task types, plus "start" and "end" structural nodes.
 */
export type WorkflowNodeType = "start" | "end" | TaskType;

export interface WorkflowNodeData {
	[key: string]: unknown;
	/** Display label */
	label: string;
	/** Optional description */
	description?: string;
	/** The SW 1.0 task type (or "start"/"end" for structural nodes) */
	taskType: WorkflowNodeType;
	/** The full task configuration (varies by task type) */
	taskConfig: Record<string, unknown>;
	/** Runtime status for execution visualization */
	status?: "idle" | "running" | "success" | "error" | "skipped";
	/** Whether the node is enabled (maps to task.if) */
	enabled?: boolean;
}

export interface WorkflowNode {
	id: string;
	type: WorkflowNodeType;
	position: { x: number; y: number };
	data: WorkflowNodeData;
}

export interface WorkflowEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: string | null;
	targetHandle?: string | null;
	label?: string;
	type?: string;
}

// ---------------------------------------------------------------------------
// Graph container
// ---------------------------------------------------------------------------

export interface WorkflowGraph {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}
