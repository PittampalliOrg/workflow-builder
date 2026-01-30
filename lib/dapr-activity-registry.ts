/**
 * Dapr Activity Registry
 *
 * Follows the same pattern as plugins/registry.ts but for Dapr activities.
 * Each activity maps to a ctx.call_activity() invocation in the Dapr workflow.
 *
 * Activity definitions aligned with planner-orchestrator/activities/*.py.
 *
 * For plugin-based activities (slack/send-message, resend/send-email, etc.),
 * the orchestrator calls the activity-executor service which dynamically
 * loads and executes the appropriate step handler.
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
  serviceName?: string; // Dapr app-id target
  serviceMethod?: string; // HTTP method/path on the target service
  timeout?: number; // seconds
  inputFields: DaprActivityConfigField[];
  outputFields: OutputField[];
  sourceFile?: string; // "activities/planning.py"
  sourceLanguage?: string; // "python" or "typescript"
  // Plugin-specific fields
  isPluginActivity?: boolean; // true if this activity routes to activity-executor
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
// Auto-register all plugin actions as Dapr activities that route to activity-executor

/**
 * Convert a plugin action to a Dapr activity definition
 */
function pluginActionToDaprActivity(action: ActionWithFullId): DaprActivity {
  return {
    name: `plugin:${action.id}`,
    label: action.label,
    description: action.description,
    category: action.category,
    serviceName: "activity-executor",
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
    "Generic activity that executes any plugin step handler via the activity-executor service. " +
    "The orchestrator passes the action ID and the service dynamically loads and runs the appropriate handler.",
  category: "Plugin",
  serviceName: "activity-executor",
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

// ─── AI Activities ───────────────────────────────────────────────────────────

registerDaprActivity({
  name: "generate_text",
  label: "Generate Text",
  description:
    "Generates text using an AI model via Dapr service invocation.",
  category: "AI",
  serviceName: "ai-service",
  serviceMethod: "POST /generate/text",
  timeout: 120,
  inputFields: [
    {
      key: "prompt",
      label: "Prompt",
      type: "template-textarea",
      placeholder: "Enter the prompt for text generation...",
      rows: 4,
    },
    {
      key: "model",
      label: "Model",
      type: "template-input",
      placeholder: "e.g., gpt-4, claude-3-sonnet",
    },
    {
      key: "max_tokens",
      label: "Max Tokens",
      type: "number",
      placeholder: "1024",
    },
    {
      key: "temperature",
      label: "Temperature",
      type: "number",
      placeholder: "0.7",
      min: 0,
    },
  ],
  outputFields: [
    { field: "text", description: "Generated text content" },
    { field: "usage", description: "Token usage statistics" },
    { field: "model", description: "Model used for generation" },
  ],
  sourceFile: "activities/generate_text.ts",
  sourceLanguage: "typescript",
});

registerDaprActivity({
  name: "generate_image",
  label: "Generate Image",
  description:
    "Generates an image using an AI model via Dapr service invocation.",
  category: "AI",
  serviceName: "ai-service",
  serviceMethod: "POST /generate/image",
  timeout: 180,
  inputFields: [
    {
      key: "prompt",
      label: "Prompt",
      type: "template-textarea",
      placeholder: "Describe the image you want to generate...",
      rows: 3,
    },
    {
      key: "model",
      label: "Model",
      type: "template-input",
      placeholder: "e.g., dall-e-3, stable-diffusion",
    },
    {
      key: "size",
      label: "Size",
      type: "select",
      placeholder: "Select image size",
      options: [
        { value: "256x256", label: "256x256" },
        { value: "512x512", label: "512x512" },
        { value: "1024x1024", label: "1024x1024" },
        { value: "1792x1024", label: "1792x1024 (Wide)" },
        { value: "1024x1792", label: "1024x1792 (Tall)" },
      ],
    },
    {
      key: "quality",
      label: "Quality",
      type: "select",
      placeholder: "Select quality",
      options: [
        { value: "standard", label: "Standard" },
        { value: "hd", label: "HD" },
      ],
    },
  ],
  outputFields: [
    { field: "url", description: "URL of the generated image" },
    { field: "revised_prompt", description: "Revised prompt used" },
  ],
  sourceFile: "activities/generate_image.ts",
  sourceLanguage: "typescript",
});

// ─── Notification Activities ─────────────────────────────────────────────────

registerDaprActivity({
  name: "send_email",
  label: "Send Email",
  description:
    "Sends an email notification via Dapr service invocation.",
  category: "Notifications",
  serviceName: "notification-service",
  serviceMethod: "POST /email",
  timeout: 30,
  inputFields: [
    {
      key: "to",
      label: "To",
      type: "template-input",
      placeholder: "recipient@example.com",
    },
    {
      key: "subject",
      label: "Subject",
      type: "template-input",
      placeholder: "Email subject line",
    },
    {
      key: "body",
      label: "Body",
      type: "template-textarea",
      placeholder: "Email body content (supports HTML)",
      rows: 6,
    },
    {
      key: "cc",
      label: "CC",
      type: "template-input",
      placeholder: "Optional CC recipients (comma-separated)",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the email was sent" },
    { field: "message_id", description: "Email message ID" },
  ],
  sourceFile: "activities/send_email.ts",
  sourceLanguage: "typescript",
});

registerDaprActivity({
  name: "send_slack_message",
  label: "Send Slack Message",
  description:
    "Sends a message to a Slack channel via Dapr service invocation.",
  category: "Notifications",
  serviceName: "notification-service",
  serviceMethod: "POST /slack",
  timeout: 30,
  inputFields: [
    {
      key: "channel",
      label: "Channel",
      type: "template-input",
      placeholder: "#general or @username",
    },
    {
      key: "message",
      label: "Message",
      type: "template-textarea",
      placeholder: "Message content (supports Slack markdown)",
      rows: 4,
    },
    {
      key: "thread_ts",
      label: "Thread Timestamp",
      type: "template-input",
      placeholder: "Optional: reply to a specific thread",
    },
  ],
  outputFields: [
    { field: "success", description: "Whether the message was sent" },
    { field: "ts", description: "Message timestamp" },
    { field: "channel", description: "Channel ID where message was posted" },
  ],
  sourceFile: "activities/send_slack_message.ts",
  sourceLanguage: "typescript",
});

// ─── Integration Activities ──────────────────────────────────────────────────

registerDaprActivity({
  name: "http_request",
  label: "HTTP Request",
  description:
    "Makes an HTTP request to an external API.",
  category: "Integration",
  timeout: 60,
  inputFields: [
    {
      key: "method",
      label: "Method",
      type: "select",
      placeholder: "Select HTTP method",
      options: [
        { value: "GET", label: "GET" },
        { value: "POST", label: "POST" },
        { value: "PUT", label: "PUT" },
        { value: "PATCH", label: "PATCH" },
        { value: "DELETE", label: "DELETE" },
      ],
    },
    {
      key: "url",
      label: "URL",
      type: "template-input",
      placeholder: "https://api.example.com/endpoint",
    },
    {
      key: "headers",
      label: "Headers (JSON)",
      type: "template-textarea",
      placeholder: '{"Authorization": "Bearer {{token}}"}',
      rows: 3,
    },
    {
      key: "body",
      label: "Body (JSON)",
      type: "template-textarea",
      placeholder: '{"key": "value"}',
      rows: 4,
    },
  ],
  outputFields: [
    { field: "status", description: "HTTP status code" },
    { field: "body", description: "Response body" },
    { field: "headers", description: "Response headers" },
  ],
  sourceFile: "activities/http_request.ts",
  sourceLanguage: "typescript",
});
