/**
 * Workflow UI Types
 *
 * Type definitions for the workflow dashboard UI.
 * Used to transform internal WorkflowEntry data to UI-compatible format.
 */
import type {
	DurableAgentRunSummary,
	DurableExecutionConsistency,
	DurableExternalEventSummary,
	DurablePlanArtifactSummary,
	DurableTimelineEvent,
} from "./durable-timeline";

// ============================================================================
// Status Types
// ============================================================================

/**
 * Workflow status for UI display
 */
export type WorkflowUIStatus =
	| "RUNNING"
	| "PENDING"
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
	| "EventRaised"
	| (string & {});

/**
 * Metadata for execution events
 */
export type DaprExecutionEventMetadata = {
	elapsed?: string;
	executionDuration?: string;
	status?: string;
	taskId?: string;
	source?: string;
	nodeId?: string;
	nodeName?: string;
	activityName?: string;
	durationMs?: number;
};

/**
 * Execution event for history table
 */
export type DaprExecutionEvent = {
	eventId: number | null;
	eventType: DaprExecutionEventType;
	name: string | null;
	timestamp: string;
	input?: unknown;
	output?: unknown;
	metadata?: DaprExecutionEventMetadata;
};

// ============================================================================
// Token Usage Types
// ============================================================================

/**
 * Token usage metrics for AI workflows
 */
export type TokenUsage = {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
};

// ============================================================================
// Dapr Agent Task Types
// ============================================================================

/**
 * Status of a Dapr agent task
 */
export type DaprAgentTaskStatus =
	| "pending"
	| "in_progress"
	| "completed"
	| "failed";

/**
 * A task in the Dapr agent workflow
 */
export type DaprAgentTask = {
	id: string;
	title: string;
	subject: string;
	description?: string;
	status: DaprAgentTaskStatus;
	parentId?: string | null;
	children?: DaprAgentTask[];
	blockedBy: string[];
	blocks: string[];
	startedAt?: string;
	completedAt?: string;
	error?: string;
};

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
// Trace Metadata Types
// ============================================================================

/**
 * Trace metadata for observability
 */
export type TraceMetadata = {
	trace_id?: string;
	agent_span_id?: string;
	workflow_name?: string;
	metadata?: Record<string, unknown>;
};

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
export type WorkflowCustomStatus = {
	phase: WorkflowPhase;
	progress: number; // 0-100
	message: string;
	plan_id?: string;
	currentTask?: string; // Currently executing task title
};

// ============================================================================
// Workflow List Types
// ============================================================================

/**
 * List item for table view (summary)
 */
export type WorkflowListItem = {
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
	/** Runtime status from orchestrator (if available) */
	runtimeStatus?: string;
	/** Current runtime node (if available) */
	currentNodeName?: string | null;
	/** Approval event name currently awaited by runtime */
	approvalEventName?: string | null;
	/** True when local DB and runtime states differ */
	statusDiverged?: boolean;
	/** Durable telemetry availability flags */
	hasChildRuns?: boolean;
	hasPlanArtifacts?: boolean;
	hasExternalEvents?: boolean;
};

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
	| "CANCELED"
	| "TERMINATED"
	| "PENDING"
	| "SUSPENDED"
	| "STALLED"
	| "UNKNOWN";

/**
 * Real-time Dapr workflow status (fetched from orchestrator)
 */
export type DaprWorkflowRuntimeStatus = {
	runtimeStatus: DaprRuntimeStatus;
	phase?: string;
	progress?: number;
	message?: string;
	currentNodeId?: string;
	currentNodeName?: string;
	error?: string;
};

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
	/** Canonical durable timeline across logs/events/artifacts/child runs */
	timeline?: DurableTimelineEvent[];
	/** Durable child run summaries */
	agentRuns?: DurableAgentRunSummary[];
	/** External workflow event summaries */
	externalEvents?: DurableExternalEventSummary[];
	/** Durable plan artifact summaries */
	planArtifacts?: DurablePlanArtifactSummary[];
	/** DB vs runtime consistency diagnostics */
	consistency?: DurableExecutionConsistency;
}

// ============================================================================
// Filter Types
// ============================================================================

/**
 * Filter options for workflow list
 */
export type WorkflowFilters = {
	search?: string;
	status?: WorkflowUIStatus[];
	appId?: string;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get display color class for status
 */
export function getStatusColor(status: WorkflowUIStatus): string {
	switch (status) {
		case "RUNNING":
		case "PENDING":
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
	status: WorkflowUIStatus,
): "default" | "secondary" | "destructive" | "outline" {
	switch (status) {
		case "COMPLETED":
			return "default";
		case "RUNNING":
		case "PENDING":
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
		case "workflow_completed":
			return "text-green-600";
		case "workflow_failed":
			return "text-red-600";
		case "OrchestratorStarted":
		case "workflow_started":
			return "text-blue-600";
		case "TaskCompleted":
		case "node_completed":
			return "text-emerald-600";
		case "TaskScheduled":
		case "node_scheduled":
			return "text-purple-600";
		case "node_started":
			return "text-indigo-600";
		case "EventRaised":
		case "approval_requested":
		case "approval_responded":
			return "text-orange-600";
		case "child_run_scheduled":
			return "text-cyan-600";
		case "child_run_completed":
			return "text-lime-600";
		case "child_run_failed":
			return "text-rose-600";
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
