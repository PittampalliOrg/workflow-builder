/**
 * Workflow UI Types
 *
 * Type definitions for the workflow dashboard UI.
 * Used to transform internal WorkflowEntry data to UI-compatible format.
 */

// ============================================================================
// Status Types
// ============================================================================

/**
 * Workflow status for UI display
 */
export type WorkflowUIStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SUSPENDED"
  | "TERMINATED";

// ============================================================================
// Execution Event Types
// ============================================================================

/**
 * Event types for workflow execution history
 */
export type DaprExecutionEventType =
  | "ExecutionCompleted"
  | "OrchestratorStarted"
  | "TaskCompleted"
  | "TaskScheduled"
  | "EventRaised";

/**
 * Metadata for execution events
 */
export interface DaprExecutionEventMetadata {
  elapsed?: string;
  executionDuration?: string;
  status?: string;
  taskId?: string;
}

/**
 * Execution event for history table
 */
export interface DaprExecutionEvent {
  eventId: number | null;
  eventType: DaprExecutionEventType;
  name: string | null;
  timestamp: string;
  input?: unknown;
  output?: unknown;
  metadata?: DaprExecutionEventMetadata;
}

// ============================================================================
// Workflow Name Stats Types
// ============================================================================

/**
 * Aggregated statistics for a workflow type (name + appId combination)
 * Used in the "Workflow names" tab to show summary stats
 */
export interface WorkflowNameStats {
  name: string; // workflowType
  appId: string;
  totalExecutions: number;
  runningCount: number;
  successCount: number;
  failedCount: number;
}

// ============================================================================
// Token Usage Types
// ============================================================================

/**
 * Token usage metrics for AI workflows
 */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

// ============================================================================
// Dapr Agent Task Types
// ============================================================================

/**
 * Status of a Dapr agent task
 */
export type DaprAgentTaskStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * A task in the Dapr agent workflow
 */
export interface DaprAgentTask {
  id: string;
  title: string;
  description?: string;
  status: DaprAgentTaskStatus;
  parentId?: string | null;
  children?: DaprAgentTask[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

/**
 * Get status color class for task status
 */
export function getTaskStatusColor(status: DaprAgentTaskStatus): string {
  switch (status) {
    case "pending":
      return "text-gray-400";
    case "in_progress":
      return "text-blue-400";
    case "completed":
      return "text-green-400";
    case "failed":
      return "text-red-400";
    default:
      return "text-gray-400";
  }
}

/**
 * Get background color class for task status
 */
export function getTaskStatusBgColor(status: DaprAgentTaskStatus): string {
  switch (status) {
    case "pending":
      return "bg-gray-400/20";
    case "in_progress":
      return "bg-blue-400/20";
    case "completed":
      return "bg-green-400/20";
    case "failed":
      return "bg-red-400/20";
    default:
      return "bg-gray-400/20";
  }
}

// ============================================================================
// Custom Status Types (for workflow phases)
// ============================================================================

/**
 * Phase of a workflow
 */
export type WorkflowPhase =
  | "clone"
  | "exploration"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed";

/**
 * Custom status from workflow
 * Contains phase, progress, and human-readable message
 */
export interface WorkflowCustomStatus {
  phase: WorkflowPhase;
  progress: number; // 0-100
  message: string;
  plan_id?: string;
  currentTask?: string; // Currently executing task title
}

// ============================================================================
// Workflow List Types
// ============================================================================

/**
 * List item for table view (summary)
 */
export interface WorkflowListItem {
  instanceId: string;
  workflowType: string; // e.g., "planExecutionWorkflow", "planningAndExecutionWorkflow"
  appId: string; // e.g., "workflow-orchestrator", "workflow-builder"
  status: WorkflowUIStatus;
  startTime: string;
  endTime: string | null;
  /** Custom status from workflow (phase, progress, message) */
  customStatus?: WorkflowCustomStatus;
  /** Workflow name from workflows table */
  workflowName?: string;
}

// ============================================================================
// Dapr Runtime Status Types
// ============================================================================

/**
 * Real-time status from Dapr workflow runtime
 */
export type DaprRuntimeStatus =
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "TERMINATED"
  | "PENDING"
  | "SUSPENDED"
  | "UNKNOWN";

/**
 * Real-time Dapr workflow status (fetched from orchestrator)
 */
export interface DaprWorkflowRuntimeStatus {
  runtimeStatus: DaprRuntimeStatus;
  phase?: string;
  progress?: number;
  message?: string;
  currentNodeId?: string;
  currentNodeName?: string;
  error?: string;
}

// ============================================================================
// Workflow Detail Types
// ============================================================================

/**
 * Full detail view for a single workflow
 */
export interface WorkflowDetail extends WorkflowListItem {
  executionDuration: string | null;
  input: unknown;
  output: unknown;
  executionHistory: DaprExecutionEvent[];
  /** Real-time status from Dapr (if available) */
  daprStatus?: DaprWorkflowRuntimeStatus;
}

// ============================================================================
// Filter Types
// ============================================================================

/**
 * Filter options for workflow list
 */
export interface WorkflowFilters {
  search?: string;
  status?: WorkflowUIStatus[];
  appId?: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get display color class for status
 */
export function getStatusColor(status: WorkflowUIStatus): string {
  switch (status) {
    case "RUNNING":
      return "bg-blue-500";
    case "COMPLETED":
      return "bg-green-500";
    case "FAILED":
      return "bg-red-500";
    case "CANCELLED":
      return "bg-gray-500";
    case "SUSPENDED":
      return "bg-yellow-500";
    case "TERMINATED":
      return "bg-orange-500";
    default:
      return "bg-gray-400";
  }
}

/**
 * Get badge variant for status
 */
export function getStatusVariant(
  status: WorkflowUIStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "COMPLETED":
      return "default";
    case "RUNNING":
      return "secondary";
    case "FAILED":
    case "TERMINATED":
      return "destructive";
    case "SUSPENDED":
    case "CANCELLED":
      return "outline";
    default:
      return "outline";
  }
}

/**
 * Get event type display color class
 */
export function getEventTypeColor(eventType: DaprExecutionEventType): string {
  switch (eventType) {
    case "ExecutionCompleted":
      return "text-green-600";
    case "OrchestratorStarted":
      return "text-blue-600";
    case "TaskCompleted":
      return "text-emerald-600";
    case "TaskScheduled":
      return "text-purple-600";
    case "EventRaised":
      return "text-orange-600";
    default:
      return "text-gray-600";
  }
}

/**
 * Get display label for workflow phase
 */
export function getPhaseLabel(phase: WorkflowPhase): string {
  switch (phase) {
    case "clone":
      return "Cloning";
    case "exploration":
      return "Exploring";
    case "planning":
      return "Planning";
    case "awaiting_approval":
      return "Awaiting Approval";
    case "executing":
      return "Executing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return phase;
  }
}

/**
 * Get color class for workflow phase
 */
export function getPhaseColor(phase: WorkflowPhase): string {
  switch (phase) {
    case "clone":
    case "exploration":
      return "text-blue-400";
    case "planning":
      return "text-purple-400";
    case "awaiting_approval":
      return "text-yellow-400";
    case "executing":
      return "text-amber-400";
    case "completed":
      return "text-green-400";
    case "failed":
      return "text-red-400";
    default:
      return "text-gray-400";
  }
}
