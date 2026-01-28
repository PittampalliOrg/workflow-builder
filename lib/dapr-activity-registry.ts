/**
 * Dapr Activity Registry
 *
 * Follows the same pattern as plugins/registry.ts but for Dapr activities.
 * Each activity maps to a ctx.call_activity() invocation in the Dapr workflow.
 *
 * Activity definitions aligned with planner-orchestrator/activities/*.py.
 */

import type {
  ActionConfigFieldBase,
  OutputField,
} from "@/plugins/registry";

export type DaprActivityConfigField = ActionConfigFieldBase;

export type DaprActivity = {
  name: string; // "run_planning"
  label: string; // "Run Planning Agent"
  description: string;
  category: string; // "Agent", "State", "Events"
  serviceName?: string; // Dapr app-id target
  serviceMethod?: string; // HTTP method/path on the target service
  timeout?: number; // seconds
  inputFields: DaprActivityConfigField[];
  outputFields: OutputField[];
  sourceFile?: string; // "activities/planning.py"
  sourceLanguage?: string; // "python"
};

// Registry storage
const activityRegistry = new Map<string, DaprActivity>();

/**
 * Register a Dapr activity
 */
export function registerDaprActivity(activity: DaprActivity): void {
  activityRegistry.set(activity.name, activity);
}

/**
 * Get a Dapr activity by name
 */
export function getDaprActivity(name: string): DaprActivity | undefined {
  return activityRegistry.get(name);
}

/**
 * Get all registered Dapr activities
 */
export function getAllDaprActivities(): DaprActivity[] {
  return Array.from(activityRegistry.values());
}

/**
 * Get Dapr activities grouped by category
 */
export function getDaprActivitiesByCategory(): Record<string, DaprActivity[]> {
  const categories: Record<string, DaprActivity[]> = {};

  for (const activity of activityRegistry.values()) {
    if (!categories[activity.category]) {
      categories[activity.category] = [];
    }
    categories[activity.category].push(activity);
  }

  return categories;
}

// ─── Planner-Agent Activities ────────────────────────────────────────────────
// Aligned with planner-orchestrator/activities/*.py

registerDaprActivity({
  name: "run_planning",
  label: "Run Planning Agent",
  description:
    "Invokes the planning agent via Dapr service invocation to analyze a feature request and generate a structured plan with tasks.",
  category: "Agent",
  serviceName: "planner-agent-plan",
  serviceMethod: "POST /plan",
  timeout: 600,
  inputFields: [
    {
      key: "prompt",
      label: "Feature Request",
      type: "template-textarea",
      placeholder: "Describe the feature to plan and implement...",
      rows: 6,
    },
    {
      key: "cwd",
      label: "Working Directory",
      type: "template-input",
      placeholder: "Working directory for the agent (e.g. /workspace)",
    },
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Auto-assigned by orchestrator",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether planning succeeded" },
    { field: "tasks", description: "Array of planned tasks" },
    { field: "task_count", description: "Number of tasks generated" },
    { field: "workflow_id", description: "Workflow instance ID" },
  ],
  sourceFile: "activities/planning.py",
  sourceLanguage: "python",
});

registerDaprActivity({
  name: "persist_tasks",
  label: "Persist Tasks",
  description:
    "Saves the planned tasks to the Dapr Redis statestore under key tasks:{workflow_id} for persistence and later retrieval.",
  category: "State",
  timeout: 30,
  inputFields: [
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Workflow instance ID for statestore key",
    },
    {
      key: "tasks",
      label: "Tasks",
      type: "template-textarea",
      placeholder: "Tasks JSON array to persist",
      rows: 4,
    },
  ],
  outputFields: [
    { field: "success", description: "Whether persistence succeeded" },
    { field: "count", description: "Number of tasks saved" },
    { field: "tasks", description: "The persisted tasks array" },
    { field: "workflow_id", description: "Workflow instance ID" },
  ],
  sourceFile: "activities/persist_tasks.py",
  sourceLanguage: "python",
});

registerDaprActivity({
  name: "run_execution",
  label: "Run Execution Agent",
  description:
    "Executes the approved plan by invoking the execution agent via Dapr service invocation to run each task.",
  category: "Agent",
  serviceName: "planner-agent-exec",
  serviceMethod: "POST /execute",
  timeout: 1800,
  inputFields: [
    {
      key: "prompt",
      label: "Execution Prompt",
      type: "template-textarea",
      placeholder: "Feature request / execution instructions",
      rows: 4,
    },
    {
      key: "cwd",
      label: "Working Directory",
      type: "template-input",
      placeholder: "Working directory for the agent",
    },
    {
      key: "tasks",
      label: "Tasks",
      type: "template-textarea",
      placeholder: "Tasks to execute (from planning phase)",
      rows: 4,
    },
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Workflow instance ID",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether execution succeeded" },
    { field: "workflow_id", description: "Workflow instance ID" },
  ],
  sourceFile: "activities/execution.py",
  sourceLanguage: "python",
});

registerDaprActivity({
  name: "publish_event",
  label: "Publish Event",
  description:
    "Publishes a workflow stream event to the Dapr pub/sub system (topic: workflow.stream) for real-time SSE updates.",
  category: "Events",
  timeout: 10,
  inputFields: [
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Workflow instance ID",
    },
    {
      key: "event_type",
      label: "Event Type",
      type: "template-input",
      placeholder: "e.g. initial, task_progress, execution_started, execution_completed",
    },
    {
      key: "data",
      label: "Event Data",
      type: "template-textarea",
      placeholder: "JSON payload for the event",
      rows: 3,
    },
    {
      key: "task_id",
      label: "Task ID",
      type: "template-input",
      placeholder: "Optional task identifier",
    },
    {
      key: "agent_id",
      label: "Agent ID",
      type: "template-input",
      placeholder: 'Agent identifier (default: "claude-planner")',
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the event was published" },
    { field: "event_id", description: "Generated event ID" },
  ],
  sourceFile: "activities/publish_event.py",
  sourceLanguage: "python",
});
