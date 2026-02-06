/**
 * Code Generation Utilities
 *
 * Generates code representations for workflows and nodes.
 * Used by the Code tab in the properties panel.
 */

import type { WorkflowNode, WorkflowEdge } from "./workflow-store";
import { generateWorkflowDefinition } from "./workflow-definition";

export interface CodeFile {
  filename: string;
  language: string;
  content: string;
}

/**
 * Generate code representation for a workflow
 */
export function generateWorkflowCode(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  options: { functionName?: string; workflowId?: string } = {}
): { code: string; language: string } {
  const { workflowId = "workflow" } = options;

  // Generate the workflow definition JSON
  const definition = generateWorkflowDefinition(
    nodes,
    edges,
    workflowId,
    options.functionName
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
  const { type, data } = node;

  if (type === "trigger" || data.type === "trigger") {
    return generateTriggerCode(node);
  }

  if (type === "action" || data.type === "action") {
    return generateActionCode(node);
  }

  if (type === "activity") {
    return generateActivityCode(node);
  }

  if (type === "approval-gate") {
    return generateApprovalGateCode(node);
  }

  if (type === "timer") {
    return generateTimerCode(node);
  }

  // Default: show node configuration as JSON
  return JSON.stringify(
    {
      id: node.id,
      type: node.type,
      data: node.data,
    },
    null,
    2
  );
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
      2
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
  const actionType = config.actionType as string;

  if (!actionType) {
    return "// No action configured";
  }

  // Show the function invocation structure
  const invocation = {
    function_slug: actionType,
    node_id: node.id,
    node_name: node.data.label,
    input: { ...config },
  };

  // Remove internal fields from input
  delete invocation.input.actionType;
  delete invocation.input.integrationId;

  return `// Action: ${actionType}
//
// This node calls the "${actionType}" OpenFunction.
// The function-router service routes the request to the appropriate
// Knative service based on the function slug.

// Function invocation payload:
${JSON.stringify(invocation, null, 2)}
`;
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
  const timeoutSeconds = (config.timeoutSeconds as number) || 86400;

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
  if (hours > 0) durationStr += `${hours}h `;
  if (minutes > 0) durationStr += `${minutes}m `;
  if (seconds > 0 || durationStr === "") durationStr += `${seconds}s`;

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
 * Get code files for a complete workflow
 */
export function getDaprWorkflowCodeFiles(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  workflowName: string
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
