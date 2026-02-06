/**
 * Execution Graph Types
 *
 * Type definitions for the React Flow execution graph visualization.
 */

import type { Node, Edge } from "@xyflow/react";
import type { DaprExecutionEventType } from "./workflow-ui";

// ============================================================================
// Node Data Types
// ============================================================================

/**
 * Handle configuration for nodes
 */
export interface NodeHandles {
  target?: boolean;
  source?: boolean;
}

/**
 * Data payload for execution event nodes
 */
export interface ExecutionNodeData {
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
export interface ExecutionGraph {
  nodes: ExecutionFlowNode[];
  edges: ExecutionFlowEdge[];
}
