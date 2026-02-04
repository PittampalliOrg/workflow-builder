/**
 * Workflow Definition Types
 *
 * Shared types for workflow definitions used by both the Next.js app
 * and the TypeScript orchestrator service. These types define the
 * serializable format for workflows that can be stored and executed.
 */

import type { WorkflowNodeType, WorkflowNodeData } from "./workflow-store";

/**
 * Serialized node format for workflow definitions
 * Contains all the data needed to execute a node in the orchestrator
 */
export interface SerializedNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  description?: string;
  enabled: boolean;
  position: { x: number; y: number };
  config: Record<string, unknown>;
}

/**
 * Serialized edge format for workflow definitions
 */
export interface SerializedEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/**
 * Complete workflow definition that can be stored and executed
 */
export interface WorkflowDefinition {
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
}

/**
 * Input to start a workflow execution
 */
export interface WorkflowExecutionInput {
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
}

/**
 * Output from a completed workflow execution
 */
export interface WorkflowExecutionOutput {
  success: boolean;
  /** Outputs from each node keyed by node ID */
  outputs: Record<string, unknown>;
  /** Error message if failed */
  error?: string;
  /** Total execution duration in milliseconds */
  durationMs: number;
  /** Final phase of the workflow */
  phase: WorkflowPhase;
}

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
export interface WorkflowStatusUpdate {
  workflowId: string;
  executionId: string;
  phase: WorkflowPhase;
  progress: number; // 0-100
  message?: string;
  currentNodeId?: string;
  currentNodeName?: string;
  outputs?: Record<string, unknown>;
}

/**
 * Activity execution request sent to the activity-executor service
 */
export interface ActivityExecutionRequest {
  activityId: string; // e.g., "slack/send-message"
  executionId: string;
  workflowId: string;
  nodeId: string;
  nodeName: string;
  input: Record<string, unknown>;
  nodeOutputs?: Record<string, { label: string; data: unknown }>;
  integrationId?: string;
}

/**
 * Activity execution result from the activity-executor service
 */
export interface ActivityExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  durationMs: number;
}

/**
 * Approval gate configuration
 */
export interface ApprovalGateConfig {
  eventName: string;
  timeoutSeconds: number;
  approvers?: string[];
  message?: string;
}

/**
 * Timer configuration
 */
export interface TimerConfig {
  durationSeconds: number;
  label?: string;
}

/**
 * Publish event configuration
 */
export interface PublishEventConfig {
  topic: string;
  eventType: string;
  data?: Record<string, unknown>;
}
