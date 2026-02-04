/**
 * Core Types for Workflow Orchestrator
 *
 * These types define the data structures used by the orchestrator
 * for workflow execution, status tracking, and inter-service communication.
 */

/**
 * Node types supported by the workflow engine
 */
export type WorkflowNodeType =
  | "trigger"
  | "action"
  | "condition"
  | "activity"
  | "approval-gate"
  | "timer"
  | "publish-event"
  | "add";

/**
 * Serialized node format for workflow definitions
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
  createdAt?: string;
  updatedAt?: string;
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
 * Input to the dynamic workflow function
 */
export interface DynamicWorkflowInput {
  definition: WorkflowDefinition;
  triggerData: Record<string, unknown>;
  integrations?: Record<string, Record<string, string>>;
  /** Database execution ID for logging (links to workflow_executions.id) */
  dbExecutionId?: string;
}

/**
 * Output from the dynamic workflow function
 */
export interface DynamicWorkflowOutput {
  success: boolean;
  outputs: Record<string, unknown>;
  error?: string;
  durationMs: number;
  phase: WorkflowPhase;
}

/**
 * Custom status stored in Dapr workflow state
 */
export interface WorkflowCustomStatus {
  phase: WorkflowPhase;
  progress: number; // 0-100
  message?: string;
  currentNodeId?: string;
  currentNodeName?: string;
}

/**
 * Activity execution request sent to the activity-executor service
 */
export interface ActivityExecutionRequest {
  activity_id: string; // e.g., "slack/send-message"
  execution_id: string;
  workflow_id: string;
  node_id: string;
  node_name: string;
  input: Record<string, unknown>;
  node_outputs?: Record<string, { label: string; data: unknown }>;
  integration_id?: string;
}

/**
 * Activity execution result from the activity-executor service
 */
export interface ActivityExecutionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
}

/**
 * Approval gate configuration
 */
export interface ApprovalGateConfig {
  eventName: string;
  timeoutSeconds?: number;
  timeoutHours?: number;
  approvers?: string[];
  message?: string;
}

/**
 * Timer configuration
 */
export interface TimerConfig {
  durationSeconds?: number;
  durationMinutes?: number;
  durationHours?: number;
}

/**
 * Action node configuration
 */
export interface ActionNodeConfig {
  actionId?: string;
  activityName?: string;
  integrationId?: string;
  [key: string]: unknown;
}
