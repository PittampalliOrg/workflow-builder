/**
 * Dapr Activity Registry
 *
 * Follows the same pattern as plugins/registry.ts but for Dapr activities.
 * Each activity maps to a ctx.call_activity() invocation in the Dapr workflow.
 *
 * NOTE: Plugin-based function execution (slack/send-message, openai/generate-text, etc.)
 * now goes through the action node type which routes to:
 *   workflow-orchestrator → function-router → OpenFunctions (Knative)
 *
 * This registry is for workflow control flow activities (approval gates, timers)
 * and the generic plugin step executor.
 */

import type { ActionConfigFieldBase, OutputField } from "@/lib/actions/types";

export type DaprActivityConfigField = ActionConfigFieldBase;

export type DaprActivity = {
	name: string; // "execute_plugin_step"
	label: string; // "Execute Plugin Step"
	description: string;
	category: string; // "Plugin", "State", "Events"
	icon?: string; // Lucide icon name (e.g., "Lightbulb", "GitBranch")
	serviceName?: string; // Dapr app-id target
	serviceMethod?: string; // HTTP method/path on the target service
	timeout?: number; // seconds
	inputFields: DaprActivityConfigField[];
	outputFields: OutputField[];
	sourceFile?: string;
	sourceLanguage?: string; // "python" or "typescript"
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

// ─── Generic Plugin Step Executor Activity ────────────────────────────────
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
			placeholder:
				"JSON object with outputs from previous nodes (for template resolution)",
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
