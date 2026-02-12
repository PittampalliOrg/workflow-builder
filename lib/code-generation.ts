/**
 * Code Generation Utilities
 *
 * Generates code representations for workflows and nodes.
 * Used by the Code tab in the properties panel.
 */

import { generateWorkflowDefinition } from "./workflow-definition";
import { resolveActionCode } from "./export/action-code-resolver";
import type { WorkflowEdge, WorkflowNode } from "./workflow-store";

export type CodeFile = {
	filename: string;
	language: string;
	content: string;
};

/**
 * Generate code representation for a workflow
 */
export function generateWorkflowCode(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	options: { functionName?: string; workflowId?: string } = {},
): { code: string; language: string } {
	const { workflowId = "workflow" } = options;

	// Generate the workflow definition JSON
	const definition = generateWorkflowDefinition(
		nodes,
		edges,
		workflowId,
		options.functionName,
	);

	return {
		code: JSON.stringify(definition, null, 2),
		language: "json",
	};
}

/**
 * Generate code representation for a single node
 */
export function generateNodeCode(node: WorkflowNode): string {
	return getNodeCodeFile(node).content;
}

/**
 * Generate code for trigger nodes
 */
function generateTriggerCode(node: WorkflowNode): string {
	const config = node.data.config || {};
	const triggerType = config.triggerType as string;

	if (triggerType === "Schedule") {
		// Show cron configuration
		return JSON.stringify(
			{
				crons: [
					{
						path: "/api/workflows/execute",
						schedule: config.cronExpression || "0 0 * * *",
					},
				],
			},
			null,
			2,
		);
	}

	if (triggerType === "Webhook") {
		const webhookPath = (config.webhookPath as string) || "/webhook";
		return `// Webhook endpoint: POST ${webhookPath}
//
// Request body will be passed as triggerData to the workflow.
//
// Example curl command:
// curl -X POST https://your-domain${webhookPath} \\
//   -H "Content-Type: application/json" \\
//   -H "x-api-key: YOUR_API_KEY" \\
//   -d '{"key": "value"}'
`;
	}

	// Manual trigger
	return `// Manual trigger
//
// This workflow is triggered manually from the UI.
// Click the "Run" button to execute the workflow.
`;
}

/**
 * Generate code for action nodes (OpenFunction calls)
 */
function generateActionCode(node: WorkflowNode): string {
	const config = node.data.config || {};
	const actionType = config.actionType as string | undefined;

	const resolved = resolveActionCode({
		actionType,
		config,
		nodeId: node.id,
		nodeName: node.data.label || node.id,
	});

	return resolved.content;
}

/**
 * Generate code for Dapr activity nodes
 */
function generateActivityCode(node: WorkflowNode): string {
	const config = node.data.config || {};
	const activityName = config.activityName as string;

	return `# Dapr Activity: ${activityName || "unnamed"}
#
# This activity is executed by the Dapr workflow runtime.
# Activities are the building blocks of durable workflows.

activity_config = ${JSON.stringify(config, null, 2)}
`;
}

/**
 * Generate code for approval gate nodes
 */
function generateApprovalGateCode(node: WorkflowNode): string {
	const config = node.data.config || {};
	const eventName = (config.eventName as string) || "approval";
	const timeoutSeconds = (config.timeoutSeconds as number) || 86_400;

	return `# Approval Gate: ${eventName}
#
# This node pauses workflow execution and waits for an external event.
# The workflow will resume when the event is received or timeout occurs.

event_name = "${eventName}"
timeout_seconds = ${timeoutSeconds}  # ${Math.floor(timeoutSeconds / 3600)} hours

# To approve/reject via API:
# POST /api/workflows/{workflowId}/executions/{executionId}/events
# {
#   "eventName": "${eventName}",
#   "approved": true,
#   "reason": "Optional reason"
# }
`;
}

/**
 * Generate code for timer nodes
 */
function generateTimerCode(node: WorkflowNode): string {
	const config = node.data.config || {};
	const durationSeconds = (config.durationSeconds as number) || 60;

	const hours = Math.floor(durationSeconds / 3600);
	const minutes = Math.floor((durationSeconds % 3600) / 60);
	const seconds = durationSeconds % 60;

	let durationStr = "";
	if (hours > 0) {
		durationStr += `${hours}h `;
	}
	if (minutes > 0) {
		durationStr += `${minutes}m `;
	}
	if (seconds > 0 || durationStr === "") {
		durationStr += `${seconds}s`;
	}

	return `# Timer: ${durationStr.trim()}
#
# This node pauses workflow execution for the specified duration.
# Dapr workflow runtime handles the timer durably.

duration_seconds = ${durationSeconds}
`;
}

/**
 * Get code files for a Dapr node (activity, approval-gate, timer)
 */
export function getDaprNodeCodeFiles(node: WorkflowNode): CodeFile[] {
	const nodeType = node.type || node.data.type;

	if (nodeType === "activity") {
		return [
			{
				filename: "activity.py",
				language: "python",
				content: generateActivityCode(node),
			},
		];
	}

	if (nodeType === "approval-gate") {
		return [
			{
				filename: "approval_gate.py",
				language: "python",
				content: generateApprovalGateCode(node),
			},
		];
	}

	if (nodeType === "timer") {
		return [
			{
				filename: "timer.py",
				language: "python",
				content: generateTimerCode(node),
			},
		];
	}

	return [
		{
			filename: "node.json",
			language: "json",
			content: generateNodeCode(node),
		},
	];
}

/**
 * Get a code file representation for any node type.
 * Used by node Code tabs to keep filename/language/content consistent.
 */
export function getNodeCodeFile(node: WorkflowNode): CodeFile {
	const nodeType = node.type || node.data.type;

	if (
		nodeType === "activity" ||
		nodeType === "approval-gate" ||
		nodeType === "timer" ||
		nodeType === "publish-event"
	) {
		const file = getDaprNodeCodeFiles(node)[0];
		if (file) {
			return file;
		}
	}

	if (nodeType === "trigger" || node.data.type === "trigger") {
		const triggerType = (node.data.config?.triggerType as string) || "";
		if (triggerType === "Schedule") {
			return {
				filename: "schedule.json",
				language: "json",
				content: generateTriggerCode(node),
			};
		}

		if (triggerType === "Webhook") {
			const webhookPath =
				(node.data.config?.webhookPath as string) || "/webhook";
			return {
				filename: `webhook${webhookPath}.ts`,
				language: "typescript",
				content: generateTriggerCode(node),
			};
		}

		return {
			filename: "trigger.ts",
			language: "typescript",
			content: generateTriggerCode(node),
		};
	}

	if (nodeType === "action" || node.data.type === "action") {
		const resolved = resolveActionCode({
			actionType: node.data.config?.actionType as string | undefined,
			config: node.data.config || {},
			nodeId: node.id,
			nodeName: node.data.label || node.id,
		});

		return {
			filename: resolved.filename,
			language: resolved.language,
			content: resolved.content,
		};
	}

	return {
		filename: "node.json",
		language: "json",
		content: JSON.stringify(
			{
				id: node.id,
				type: node.type,
				data: node.data,
			},
			null,
			2,
		),
	};
}

/**
 * Get code files for a complete workflow
 */
export function getDaprWorkflowCodeFiles(
	nodes: WorkflowNode[],
	edges: WorkflowEdge[],
	workflowName: string,
): CodeFile[] {
	const { code } = generateWorkflowCode(nodes, edges, {
		functionName: workflowName,
		workflowId: workflowName,
	});

	return [
		{
			filename: `${workflowName}.json`,
			language: "json",
			content: code,
		},
	];
}
