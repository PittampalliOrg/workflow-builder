/**
 * Workflow UI Transform Functions
 *
 * Functions to transform internal database data to UI-compatible format.
 */

import type {
  Workflow,
  WorkflowExecution,
  WorkflowExecutionLog,
} from "@/lib/db/schema";
import type {
  DaprAgentTask,
  DaprExecutionEvent,
  DaprExecutionEventType,
  TokenUsage,
  TraceMetadata,
  WorkflowDetail,
  WorkflowListItem,
  WorkflowUIStatus,
} from "@/lib/types/workflow-ui";

// ============================================================================
// Timestamp Parsing
// ============================================================================

/**
 * Parse a timestamp that may be in ISO format or Date object.
 * workflow-builder uses ISO 8601 timestamps directly (no protobuf parsing needed)
 */
export function parseTimestamp(
  timestamp: string | Date | undefined | null
): string {
  if (!timestamp) {
    return "";
  }

  // If it's already a Date object
  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }

  // ISO format string
  const date = new Date(timestamp);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString();
  }

  return "";
}

// ============================================================================
// Status Mapping
// ============================================================================

/**
 * Map internal workflow execution status to UI-compatible status
 */
export function mapWorkflowStatus(
  status: "pending" | "running" | "success" | "error" | "cancelled" | string
): WorkflowUIStatus {
  const normalizedStatus = status?.toUpperCase?.() || status;

  switch (normalizedStatus) {
    case "PENDING":
    case "RUNNING":
      return "RUNNING";
    case "SUCCESS":
    case "COMPLETED":
      return "COMPLETED";
    case "ERROR":
    case "FAILED":
      return "FAILED";
    case "CANCELLED":
    case "TERMINATED":
      return "CANCELLED";
    default:
      return "RUNNING";
  }
}

// ============================================================================
// Event Type Mapping
// ============================================================================

/**
 * Map internal execution log status to Dapr event type
 */
export function mapExecutionLogEvent(
  status: "pending" | "running" | "success" | "error" | string
): DaprExecutionEventType {
  switch (status) {
    case "pending":
      return "TaskScheduled";
    case "running":
      return "TaskScheduled";
    case "success":
      return "TaskCompleted";
    case "error":
      return "TaskCompleted";
    default:
      return "TaskCompleted";
  }
}

// ============================================================================
// Duration Calculation
// ============================================================================

/**
 * Calculate duration between two timestamps
 * Returns human-readable string like "1m 23s" or "45s"
 * Always uses seconds/minutes/hours (never milliseconds)
 */
export function calculateDuration(
  startTime: string | Date,
  endTime?: string | Date | null
): string | null {
  if (!startTime) {
    return null;
  }

  const start = new Date(startTime).getTime();
  const end = endTime ? new Date(endTime).getTime() : Date.now();

  if (Number.isNaN(start) || Number.isNaN(end)) {
    return null;
  }

  const durationMs = end - start;

  // Less than 1 second
  if (durationMs < 1000) {
    return "< 1s";
  }

  // Less than 1 minute - show seconds
  if (durationMs < 60_000) {
    const seconds = Math.floor(durationMs / 1000);
    return `${seconds}s`;
  }

  // Less than 1 hour - show minutes and seconds
  if (durationMs < 3_600_000) {
    const minutes = Math.floor(durationMs / 60_000);
    const seconds = Math.floor((durationMs % 60_000) / 1000);
    if (seconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${seconds}s`;
  }

  // 1 hour or more - show hours and minutes
  const hours = Math.floor(durationMs / 3_600_000);
  const minutes = Math.floor((durationMs % 3_600_000) / 60_000);
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

/**
 * Calculate elapsed time for an event
 * Always uses seconds/minutes/hours (never milliseconds)
 */
export function calculateElapsed(
  eventTimestamp: string | Date,
  referenceTimestamp: string | Date
): string {
  const event = new Date(eventTimestamp).getTime();
  const reference = new Date(referenceTimestamp).getTime();

  if (Number.isNaN(event) || Number.isNaN(reference)) {
    return "-";
  }

  const elapsedMs = event - reference;

  // Less than 1 second
  if (elapsedMs < 1000) {
    return "< 1s";
  }

  // Less than 1 minute
  if (elapsedMs < 60_000) {
    const seconds = Math.floor(elapsedMs / 1000);
    return `${seconds}s`;
  }

  // Less than 1 hour
  if (elapsedMs < 3_600_000) {
    const minutes = Math.floor(elapsedMs / 60_000);
    const seconds = Math.floor((elapsedMs % 60_000) / 1000);
    if (seconds === 0) {
      return `${minutes}m`;
    }
    return `${minutes}m ${seconds}s`;
  }

  // 1 hour or more
  const hours = Math.floor(elapsedMs / 3_600_000);
  const minutes = Math.floor((elapsedMs % 3_600_000) / 60_000);
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

// ============================================================================
// Dapr Agent Output Parsing
// ============================================================================

/**
 * Dapr Agent Output structure
 */
export type DaprAgentOutput = {
  plan_text?: string;
  tasks?: DaprAgentTask[];
  usage?: TokenUsage;
  trace_id?: string;
  trace_metadata?: TraceMetadata;
};

/**
 * Check if output is a Dapr agent output structure
 */
export function isDaprAgentOutput(output: unknown): output is DaprAgentOutput {
  if (!output || typeof output !== "object") {
    return false;
  }

  const obj = output as Record<string, unknown>;

  // Check for common Dapr agent output fields
  return (
    "plan_text" in obj ||
    "tasks" in obj ||
    "usage" in obj ||
    "trace_id" in obj ||
    "trace_metadata" in obj
  );
}

/**
 * Parse Dapr agent output to extract structured data
 */
export function parseDaprAgentOutput(output: unknown): DaprAgentOutput | null {
  if (!isDaprAgentOutput(output)) {
    return null;
  }

  return output;
}

// ============================================================================
// Token Count Formatting
// ============================================================================

/**
 * Format token count with K/M suffix for large numbers
 * Examples: 1234 -> "1,234", 12345 -> "12.3K", 1234567 -> "1.2M"
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) {
    return count.toLocaleString();
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

// ============================================================================
// Time Formatting
// ============================================================================

/**
 * Format timestamp as relative time for recent entries, absolute for older ones.
 * - < 1 min: "Just now"
 * - < 60 mins: "X mins ago"
 * - < 24 hours: "X hours ago"
 * - Yesterday: "Yesterday at 2:30 PM"
 * - This week: "Monday at 2:30 PM"
 * - Older: "Jan 23, 2026"
 */
export function formatRelativeTime(timestamp: string | Date): string {
  if (!timestamp) {
    return "-";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  // Format time for use in combined strings
  const timeStr = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  // Less than 1 minute
  if (diffMins < 1) {
    return "Just now";
  }

  // Less than 60 minutes
  if (diffMins < 60) {
    return diffMins === 1 ? "1 min ago" : `${diffMins} mins ago`;
  }

  // Less than 24 hours
  if (diffHours < 24) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toLocaleDateString("en-US");
  const eventDateStr = date.toLocaleDateString("en-US");
  if (eventDateStr === yesterdayStr) {
    return `Yesterday at ${timeStr}`;
  }

  // Within the past week (show day name)
  if (diffDays < 7) {
    const dayName = date.toLocaleDateString("en-US", {
      weekday: "long",
    });
    return `${dayName} at ${timeStr}`;
  }

  // Older than a week - show date
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format timestamp for display (includes date)
 * Uses relative time for recent entries, absolute for older ones
 */
export function formatTimestamp(timestamp: string | Date): string {
  return formatRelativeTime(timestamp);
}

/**
 * Format timestamp as absolute date/time (for tooltips)
 * Format: "23 Jan 2026 1:06:20 PM"
 */
export function formatAbsoluteTimestamp(timestamp: string | Date): string {
  if (!timestamp) {
    return "-";
  }

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  };

  return date.toLocaleString("en-US", options);
}

/**
 * Format time only (for compact display)
 * Format: "1:07:42 PM"
 */
export function formatTimeOnly(timestamp: string | Date): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * Format full date and time for detail header
 * Format: "01:06:20 PM - 23 Jan 2026"
 */
export function formatDateTime(timestamp: string | Date): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const time = date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const dateStr = date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  return `${time} - ${dateStr}`;
}

// ============================================================================
// Execution Events Transformation
// ============================================================================

/**
 * Transform execution logs to Dapr execution events
 */
export function mapExecutionLogsToEvents(
  logs: WorkflowExecutionLog[],
  workflowStart: string | Date,
  workflowEnd?: string | Date | null,
  workflowStatus?: string,
  workflowInput?: unknown
): DaprExecutionEvent[] {
  const events: DaprExecutionEvent[] = [];
  let eventId = 1;

  // Add OrchestratorStarted event with workflow input
  events.push({
    eventId: null,
    eventType: "OrchestratorStarted",
    name: null,
    timestamp: parseTimestamp(workflowStart),
    input: workflowInput,
    metadata: {},
  });

  // Process execution logs
  for (const log of logs) {
    const eventType = mapExecutionLogEvent(log.status);

    events.push({
      eventId: eventType === "TaskScheduled" ? null : eventId++,
      eventType,
      name: log.nodeId || null,
      timestamp: parseTimestamp(log.timestamp),
      input: log.input,
      output: log.output,
      metadata: {
        status: log.status,
        taskId: log.nodeId,
      },
    });
  }

  // Add ExecutionCompleted event if workflow is complete
  if (
    workflowEnd &&
    (workflowStatus === "success" ||
      workflowStatus === "error" ||
      workflowStatus === "cancelled")
  ) {
    events.push({
      eventId,
      eventType: "ExecutionCompleted",
      name: null,
      timestamp: parseTimestamp(workflowEnd),
      metadata: {
        executionDuration:
          calculateDuration(workflowStart, workflowEnd) || undefined,
        status: mapWorkflowStatus(workflowStatus),
      },
    });
  }

  // Sort by timestamp descending (most recent first)
  return events.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

// ============================================================================
// Workflow Transformations
// ============================================================================

/** Default app ID for the workflow orchestrator */
const DEFAULT_APP_ID = "workflow-builder";

/**
 * Transform WorkflowExecution to WorkflowListItem
 */
export function toWorkflowListItem(
  execution: WorkflowExecution,
  workflow: Workflow
): WorkflowListItem {
  const startTime = parseTimestamp(execution.startedAt);
  const endTime = execution.completedAt
    ? parseTimestamp(execution.completedAt)
    : null;

  return {
    instanceId: execution.id,
    workflowType: workflow.daprWorkflowName || "dynamic-workflow",
    appId: DEFAULT_APP_ID,
    status: mapWorkflowStatus(execution.status),
    startTime,
    endTime,
    workflowName: workflow.name,
    customStatus: execution.phase
      ? {
          phase: execution.phase as any,
          progress: execution.progress ?? 0,
          message: "",
        }
      : undefined,
  };
}

/**
 * Transform WorkflowExecution to WorkflowDetail
 */
export function toWorkflowDetail(
  execution: WorkflowExecution,
  workflow: Workflow,
  logs: WorkflowExecutionLog[]
): WorkflowDetail {
  const listItem = toWorkflowListItem(execution, workflow);

  // Build execution history
  const executionHistory = mapExecutionLogsToEvents(
    logs,
    execution.startedAt,
    execution.completedAt,
    execution.status,
    execution.input
  );

  return {
    ...listItem,
    executionDuration: calculateDuration(
      execution.startedAt,
      execution.completedAt
    ),
    input: execution.input || {},
    output: execution.output || {},
    executionHistory,
  };
}

// ============================================================================
// Filtering
// ============================================================================

/**
 * Filter workflow list items by search query
 */
export function filterWorkflowsBySearch(
  workflows: WorkflowListItem[],
  search?: string
): WorkflowListItem[] {
  if (!search?.trim()) {
    return workflows;
  }

  const query = search.toLowerCase().trim();
  return workflows.filter(
    (w) =>
      w.instanceId.toLowerCase().includes(query) ||
      w.workflowType.toLowerCase().includes(query) ||
      w.workflowName?.toLowerCase().includes(query) ||
      w.appId.toLowerCase().includes(query)
  );
}

/**
 * Filter workflow list items by status
 */
export function filterWorkflowsByStatus(
  workflows: WorkflowListItem[],
  statuses?: WorkflowUIStatus[]
): WorkflowListItem[] {
  if (!statuses?.length) {
    return workflows;
  }
  return workflows.filter((w) => statuses.includes(w.status));
}

/**
 * Filter workflow list items by app ID
 */
export function filterWorkflowsByAppId(
  workflows: WorkflowListItem[],
  appId?: string
): WorkflowListItem[] {
  if (!appId?.trim()) {
    return workflows;
  }
  return workflows.filter((w) => w.appId === appId);
}

/**
 * Apply all filters to workflow list
 */
export function applyWorkflowFilters(
  workflows: WorkflowListItem[],
  filters: {
    search?: string;
    status?: WorkflowUIStatus[];
    appId?: string;
  }
): WorkflowListItem[] {
  let filtered = workflows;
  filtered = filterWorkflowsBySearch(filtered, filters.search);
  filtered = filterWorkflowsByStatus(filtered, filters.status);
  filtered = filterWorkflowsByAppId(filtered, filters.appId);
  return filtered;
}
