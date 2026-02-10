/**
 * Execution Graph Types
 *
 * Type definitions for the React Flow execution graph visualization.
 */

import type { Edge, Node } from "@xyflow/react";
import type { DaprExecutionEventType } from "./workflow-ui";

// ============================================================================
// Node Data Types
// ============================================================================

/**
 * Handle configuration for nodes
 */
export type NodeHandles = {
  target?: boolean;
  source?: boolean;
};

/**
 * Data payload for execution event nodes
 */
export interface ExecutionNodeData extends Record<string, unknown> {
  eventId: number | null;
  eventType: DaprExecutionEventType;
  name: string | null;
  timestamp: string;
  elapsed?: string;
  status?: string;
  isSelected?: boolean;
  handles?: NodeHandles;
}

// ============================================================================
// Node Types
// ============================================================================

/**
 * Execution flow node (extends React Flow Node)
 */
export type ExecutionFlowNode = Node<ExecutionNodeData, "executionEvent">;

/**
 * Union type for all node types in the execution graph
 */
export type AppNode = ExecutionFlowNode;

// ============================================================================
// Edge Types
// ============================================================================

/**
 * Edge between execution nodes
 */
export type ExecutionFlowEdge = Edge;

// ============================================================================
// Graph Types
// ============================================================================

/**
 * Complete execution graph with nodes and edges
 */
export type ExecutionGraph = {
  nodes: ExecutionFlowNode[];
  edges: ExecutionFlowEdge[];
};
