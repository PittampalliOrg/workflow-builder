/**
 * Dapr Activity Registry
 *
 * Follows the same pattern as plugins/registry.ts but for Dapr activities.
 * Each activity maps to a ctx.call_activity() invocation in the Dapr workflow.
 *
 * Activity definitions aligned with planner-orchestrator/activities/*.py.
 *
 * NOTE: Plugin-based function execution (slack/send-message, openai/generate-text, etc.)
 * now goes through the action node type which routes to:
 *   workflow-orchestrator → function-router → OpenFunctions (Knative)
 *
 * This registry is for workflow control flow activities (approval gates, timers)
 * and planner-agent specific activities.
 */

import type {
  ActionConfigFieldBase,
  OutputField,
} from "@/plugins/registry";
import {
  getAllActions,
  type ActionWithFullId,
} from "@/plugins/registry";

export type DaprActivityConfigField = ActionConfigFieldBase;

export type DaprActivity = {
  name: string; // "run_planning" or "plugin:slack/send-message"
  label: string; // "Run Planning Agent" or "Send Slack Message"
  description: string;
  category: string; // "Agent", "State", "Events", "Plugin"
  icon?: string; // Lucide icon name (e.g., "Lightbulb", "GitBranch")
  serviceName?: string; // Dapr app-id target
  serviceMethod?: string; // HTTP method/path on the target service
  timeout?: number; // seconds
  inputFields: DaprActivityConfigField[];
  outputFields: OutputField[];
  sourceFile?: string; // "activities/planning.py"
  sourceLanguage?: string; // "python" or "typescript"
  // Plugin-specific fields (legacy - kept for backwards compatibility)
  isPluginActivity?: boolean; // true if this activity is from a plugin
  pluginActionId?: string; // e.g., "slack/send-message"
  pluginIntegration?: string; // e.g., "slack"
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

// ─── Plugin Activity Registration ─────────────────────────────────────────────
// Auto-register all plugin actions as Dapr activities (metadata only - execution
// now goes through action nodes → function-router → OpenFunctions)

/**
 * Convert a plugin action to a Dapr activity definition
 */
function pluginActionToDaprActivity(action: ActionWithFullId): DaprActivity {
  return {
    name: `plugin:${action.id}`,
    label: action.label,
    description: action.description,
    category: action.category,
    serviceName: "function-router",
    serviceMethod: "POST /execute",
    timeout: 300, // 5 minute default timeout for plugin activities
    inputFields: action.configFields
      .filter((field): field is DaprActivityConfigField => field.type !== "group")
      .map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        placeholder: field.placeholder,
        defaultValue: field.defaultValue,
        options: field.options,
        rows: field.rows,
        min: field.min,
        required: field.required,
      })),
    outputFields: action.outputFields || [],
    sourceLanguage: "typescript",
    isPluginActivity: true,
    pluginActionId: action.id,
    pluginIntegration: action.integration,
  };
}

/**
 * Register all plugin actions as Dapr activities
 * Call this after plugins are loaded to populate the registry
 */
export function registerPluginActivities(): void {
  const actions = getAllActions();

  for (const action of actions) {
    const daprActivity = pluginActionToDaprActivity(action);
    registerDaprActivity(daprActivity);
  }

  console.log(`[Dapr Activity Registry] Registered ${actions.length} plugin activities`);
}

/**
 * Get all plugin-based Dapr activities
 */
export function getPluginActivities(): DaprActivity[] {
  return Array.from(activityRegistry.values()).filter(
    (activity) => activity.isPluginActivity
  );
}

/**
 * Find a plugin activity by its action ID (e.g., "slack/send-message")
 */
export function findPluginActivity(actionId: string): DaprActivity | undefined {
  return activityRegistry.get(`plugin:${actionId}`);
}

// ─── Generic Plugin Step Executor Activity ────────────────────────────────────
// This activity is called by the Python orchestrator to execute any plugin step

registerDaprActivity({
  name: "execute_plugin_step",
  label: "Execute Plugin Step",
  description:
    "Generic activity that executes any plugin step handler via the function-router service. " +
    "The orchestrator passes the action ID and the service routes to the appropriate OpenFunction.",
  category: "Plugin",
  serviceName: "function-router",
  serviceMethod: "POST /execute",
  timeout: 300,
  inputFields: [
    {
      key: "activity_id",
      label: "Activity ID",
      type: "template-input",
      placeholder: "e.g., slack/send-message, resend/send-email",
      required: true,
    },
    {
      key: "execution_id",
      label: "Execution ID",
      type: "template-input",
      placeholder: "Workflow execution ID for logging correlation",
    },
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Dapr workflow instance ID",
    },
    {
      key: "node_id",
      label: "Node ID",
      type: "template-input",
      placeholder: "Node ID in the workflow graph",
    },
    {
      key: "node_name",
      label: "Node Name",
      type: "template-input",
      placeholder: "Human-readable node name",
    },
    {
      key: "input",
      label: "Input Config",
      type: "template-textarea",
      placeholder: "JSON object with step configuration",
      rows: 4,
    },
    {
      key: "node_outputs",
      label: "Node Outputs",
      type: "template-textarea",
      placeholder: "JSON object with outputs from previous nodes (for template resolution)",
      rows: 4,
    },
    {
      key: "integration_id",
      label: "Integration ID",
      type: "template-input",
      placeholder: "ID of the integration to fetch credentials from",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the step execution succeeded" },
    { field: "data", description: "Step result data" },
    { field: "error", description: "Error message if failed" },
    { field: "duration_ms", description: "Execution duration in milliseconds" },
  ],
  sourceLanguage: "typescript",
  isPluginActivity: true,
});

// ─── Planner-Agent Activities ────────────────────────────────────────────────
// Aligned with planner-orchestrator/activities/*.py

registerDaprActivity({
  name: "run_planning",
  label: "Run Planning Agent",
  description:
    "Invokes the planning agent via Dapr service invocation to analyze a feature request and generate a structured plan with tasks.",
  category: "Agent",
  icon: "Lightbulb",
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
  sourceFile: "activities/run_planning.ts",
  sourceLanguage: "typescript",
});

registerDaprActivity({
  name: "persist_tasks",
  label: "Persist Tasks",
  description:
    "Saves the planned tasks to the Dapr Redis statestore under key tasks:{workflow_id} for persistence and later retrieval.",
  category: "State",
  icon: "Database",
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
  sourceFile: "activities/persist_tasks.ts",
  sourceLanguage: "typescript",
});

registerDaprActivity({
  name: "run_execution",
  label: "Run Execution Agent",
  description:
    "Executes the approved plan by invoking the execution agent via Dapr service invocation to run each task.",
  category: "Agent",
  icon: "Rocket",
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
  sourceFile: "activities/run_execution.ts",
  sourceLanguage: "typescript",
});

registerDaprActivity({
  name: "publish_event",
  label: "Publish Event",
  description:
    "Publishes a workflow stream event to the Dapr pub/sub system (topic: workflow.stream) for real-time SSE updates.",
  category: "Events",
  icon: "Send",
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
  sourceFile: "activities/publish_event.ts",
  sourceLanguage: "typescript",
});

// ─── Legacy Activities Removed ────────────────────────────────────────────────
// The following legacy Dapr activities have been removed to prevent duplicates:
// - generate_text (use plugin: openai/generate-text)
// - generate_image (use plugin: openai/generate-image)
// - send_email (use plugin: resend/send-email)
// - send_slack_message (use plugin: slack/send-message)
// - http_request (use system action: system/http-request)
//
// All function execution now goes through action nodes:
//   workflow-orchestrator → function-router → OpenFunctions (Knative)
// Dapr activities are reserved for workflow control flow only (approval gates, timers).

// ─── Multi-Step Workflow Activities ───────────────────────────────────────────
// Activities from dapr_multi_step_workflow.py

registerDaprActivity({
  name: "clone_repository",
  label: "Clone Repository",
  description:
    "Clones a GitHub repository with optional token authentication for the workflow workspace.",
  category: "Agent",
  icon: "GitBranch",
  serviceName: "planner-dapr-agent",
  serviceMethod: "POST /activity/clone",
  timeout: 300,
  inputFields: [
    {
      key: "owner",
      label: "Repository Owner",
      type: "template-input",
      placeholder: "e.g., PittampalliOrg",
    },
    {
      key: "repo",
      label: "Repository Name",
      type: "template-input",
      placeholder: "e.g., my-repo",
    },
    {
      key: "branch",
      label: "Branch",
      type: "template-input",
      placeholder: "main",
      defaultValue: "main",
    },
    {
      key: "token",
      label: "GitHub Token",
      type: "template-input",
      placeholder: "Optional: GitHub PAT for private repos",
    },
    {
      key: "workspace_dir",
      label: "Workspace Directory",
      type: "template-input",
      placeholder: "/app/workspace",
    },
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Auto-assigned",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether cloning succeeded" },
    { field: "path", description: "Path to cloned repository" },
    { field: "file_count", description: "Number of files in repository" },
    { field: "error", description: "Error message if failed" },
  ],
  sourceFile: "dapr_multi_step_workflow.py",
  sourceLanguage: "python",
});

registerDaprActivity({
  name: "testing",
  label: "Run Testing Agent",
  description:
    "Runs the testing phase using OpenAI agents to verify the implementation against planned test cases.",
  category: "Agent",
  icon: "TestTube2",
  serviceName: "planner-dapr-agent",
  serviceMethod: "POST /activity/testing",
  timeout: 600,
  inputFields: [
    {
      key: "plan",
      label: "Plan",
      type: "template-textarea",
      placeholder: "Plan JSON with test cases",
      rows: 4,
    },
    {
      key: "execution",
      label: "Execution Result",
      type: "template-textarea",
      placeholder: "Execution result from previous phase",
      rows: 4,
    },
    {
      key: "model",
      label: "Model",
      type: "template-input",
      placeholder: "gpt-5.2-codex",
    },
    {
      key: "max_turns",
      label: "Max Turns",
      type: "number",
      placeholder: "20",
    },
    {
      key: "max_test_retries",
      label: "Max Test Retries",
      type: "number",
      placeholder: "3",
    },
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Auto-assigned",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether testing phase succeeded" },
    { field: "testing", description: "Test results object" },
    { field: "passed", description: "Whether all tests passed" },
    { field: "tests_run", description: "Number of tests run" },
    { field: "tests_passed", description: "Number of tests passed" },
    { field: "tests_failed", description: "Number of tests failed" },
    { field: "failures", description: "Array of failure details" },
  ],
  sourceFile: "dapr_multi_step_workflow.py",
  sourceLanguage: "python",
});

registerDaprActivity({
  name: "sandboxed_execution_and_testing",
  label: "Sandboxed Execution & Testing",
  description:
    "Runs both execution and testing phases in a single isolated Agent Sandbox pod with gVisor/Kata containers.",
  category: "Agent",
  icon: "Container",
  serviceName: "planner-dapr-agent",
  serviceMethod: "POST /activity/sandbox",
  timeout: 3600,
  inputFields: [
    {
      key: "plan",
      label: "Plan",
      type: "template-textarea",
      placeholder: "Plan JSON with tasks and tests",
      rows: 4,
    },
    {
      key: "model",
      label: "Model",
      type: "template-input",
      placeholder: "gpt-5.2-codex",
    },
    {
      key: "max_turns",
      label: "Max Turns",
      type: "number",
      placeholder: "50",
    },
    {
      key: "max_test_retries",
      label: "Max Test Retries",
      type: "number",
      placeholder: "3",
    },
    {
      key: "workspace_path",
      label: "Workspace Path",
      type: "template-input",
      placeholder: "/app/workspace",
    },
    {
      key: "workflow_id",
      label: "Workflow ID",
      type: "template-input",
      placeholder: "Auto-assigned",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether both phases succeeded" },
    { field: "execution", description: "Execution result object" },
    { field: "testing", description: "Testing result object" },
    { field: "phase", description: "Phase where failure occurred (if any)" },
    { field: "error", description: "Error message if failed" },
  ],
  sourceFile: "dapr_multi_step_workflow.py",
  sourceLanguage: "python",
});
