/**
 * Dapr Code Generation
 *
 * Generates Python/YAML code views for Dapr workflow nodes.
 * Used when engineType === "dapr" instead of workflow-codegen.ts.
 */

import { getDaprActivity } from "./dapr-activity-registry";
import type { WorkflowNode, WorkflowEdge } from "./workflow-store";

export type DaprCodeFile = {
  filename: string;
  language: string; // "python" | "yaml" | "json"
  content: string;
};

/**
 * Generate code for a single activity node
 */
export function generateActivityCode(node: WorkflowNode): DaprCodeFile[] {
  const activityName =
    (node.data.config?.activityName as string) || "unknown_activity";
  const activity = getDaprActivity(activityName);
  const files: DaprCodeFile[] = [];

  if (activity) {
    // Generate Python activity function
    const inputParams = activity.inputFields
      .map((f) => `    ${f.key}: str`)
      .join("\n");

    const outputFields = activity.outputFields
      .map((f) => `    # ${f.description}`)
      .join("\n");

    files.push({
      filename: activity.sourceFile || `activities/${activityName}.py`,
      language: "python",
      content: `"""
${activity.label}
${activity.description}
"""
import dapr.ext.workflow as wf


def ${activityName}(ctx: wf.ActivityContext, input: dict) -> dict:
    """
    Activity: ${activity.label}
${activity.serviceName ? `    Service: ${activity.serviceName}` : ""}
${activity.serviceMethod ? `    Method: ${activity.serviceMethod}` : ""}
${activity.timeout ? `    Timeout: ${activity.timeout}s` : ""}

    Input:
${inputParams || "    # No input parameters"}

    Output:
${outputFields || "    # Returns dict"}
    """
${activity.serviceName ? `    # Invoke target service via Dapr service invocation
    # dapr_client.invoke_method(
    #     app_id="${activity.serviceName}",
    #     method_name="${activity.serviceMethod || "invoke"}",
    #     data=json.dumps(input),
    #     content_type="application/json",
    # )` : `    # Process input and return result`}

    return {"status": "completed"}
`,
    });
  } else {
    files.push({
      filename: `activities/${activityName}.py`,
      language: "python",
      content: `# Activity: ${activityName}
# No registry entry found for this activity

def ${activityName}(ctx, input: dict) -> dict:
    return {"status": "completed"}
`,
    });
  }

  return files;
}

/**
 * Generate code for an approval gate node
 */
export function generateApprovalGateCode(node: WorkflowNode): DaprCodeFile[] {
  const eventName =
    (node.data.config?.eventName as string) || "approval_event";
  const timeoutHours = (node.data.config?.timeoutHours as number) || 24;

  return [
    {
      filename: "workflow/approval_gate.py",
      language: "python",
      content: `"""
Approval Gate: ${node.data.label || "Plan Review"}
Waits for external approval event with timeout.
"""
from datetime import timedelta
import dapr.ext.workflow as wf


# Inside the workflow definition:
def approval_gate(ctx: wf.DaprWorkflowContext):
    # Wait for approval event with timeout
    approval_event = ctx.wait_for_external_event("${eventName}")
    timeout_event = ctx.create_timer(timedelta(hours=${timeoutHours}))

    # Race between approval and timeout
    winner = yield wf.when_any([approval_event, timeout_event])

    if winner == timeout_event:
        # Timeout reached - auto-reject
        return {"approved": False, "reason": "Timed out after ${timeoutHours} hours"}

    # Process approval result
    result = approval_event.result
    return {
        "approved": result.get("approved", False),
        "reason": result.get("reason", ""),
    }
`,
    },
  ];
}

/**
 * Generate code for a timer node
 */
export function generateTimerCode(node: WorkflowNode): DaprCodeFile[] {
  const durationSeconds =
    (node.data.config?.durationSeconds as number) || 60;

  return [
    {
      filename: "workflow/timer.py",
      language: "python",
      content: `"""
Timer: ${node.data.label || "Delay"}
Creates a timer delay in the workflow.
"""
from datetime import timedelta
import dapr.ext.workflow as wf


# Inside the workflow definition:
def timer_step(ctx: wf.DaprWorkflowContext):
    yield ctx.create_timer(timedelta(seconds=${durationSeconds}))
`,
    },
  ];
}

/**
 * Generate the full workflow definition Python code
 */
export function generateWorkflowDefinitionCode(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  workflowName = "planner_workflow"
): DaprCodeFile {
  const activityNodes = nodes.filter((n) => n.type === "activity");
  const approvalNodes = nodes.filter((n) => n.type === "approval-gate");
  const timerNodes = nodes.filter((n) => n.type === "timer");

  // Build imports
  const activityImports = activityNodes
    .map((n) => {
      const name =
        (n.data.config?.activityName as string) || "unknown_activity";
      return `from activities import ${name}`;
    })
    .join("\n");

  // Build workflow body
  const steps: string[] = [];

  // Sort nodes in execution order using edges
  const edgesBySource = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = edgesBySource.get(edge.source) || [];
    targets.push(edge.target);
    edgesBySource.set(edge.source, targets);
  }

  // Simple topological order: find trigger, then walk edges
  const triggerNode = nodes.find((n) => n.type === "trigger");
  const visited = new Set<string>();
  const orderedNodes: WorkflowNode[] = [];

  function visit(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = nodes.find((n) => n.id === nodeId);
    if (node && node.type !== "trigger" && node.type !== "add") {
      orderedNodes.push(node);
    }
    const targets = edgesBySource.get(nodeId) || [];
    for (const t of targets) {
      visit(t);
    }
  }

  if (triggerNode) {
    visit(triggerNode.id);
  }

  for (const node of orderedNodes) {
    if (node.type === "activity") {
      const actName =
        (node.data.config?.activityName as string) || "unknown_activity";
      const activity = getDaprActivity(actName);
      const timeout = activity?.timeout || 300;
      steps.push(
        `    # ${node.data.label || activity?.label || actName}
    result = yield ctx.call_activity(
        ${actName},
        input={"requirements": input_data.get("requirements", "")},
    )`
      );
    } else if (node.type === "approval-gate") {
      const eventName =
        (node.data.config?.eventName as string) || "approval_event";
      const timeoutHours =
        (node.data.config?.timeoutHours as number) || 24;
      steps.push(
        `    # ${node.data.label || "Approval Gate"}
    approval_event = ctx.wait_for_external_event("${eventName}")
    timeout_event = ctx.create_timer(timedelta(hours=${timeoutHours}))
    winner = yield wf.when_any([approval_event, timeout_event])
    if winner == timeout_event:
        raise Exception("Approval timed out")
    approval = approval_event.result
    if not approval.get("approved"):
        raise Exception("Plan rejected: " + approval.get("reason", ""))`
      );
    } else if (node.type === "timer") {
      const seconds =
        (node.data.config?.durationSeconds as number) || 60;
      steps.push(
        `    # ${node.data.label || "Timer"}
    yield ctx.create_timer(timedelta(seconds=${seconds}))`
      );
    }
  }

  const body = steps.join("\n\n");

  return {
    filename: `workflow/${workflowName}.py`,
    language: "python",
    content: `"""
Dapr Workflow: ${workflowName}
Auto-generated from visual workflow builder.
"""
from datetime import timedelta
import dapr.ext.workflow as wf
${activityImports ? `\n${activityImports}` : ""}


def ${workflowName}(ctx: wf.DaprWorkflowContext, input_data: dict):
    """Orchestrates the workflow pipeline."""
    ctx.set_custom_status({"phase": "started", "progress": 0})

${body || "    pass"}

    ctx.set_custom_status({"phase": "completed", "progress": 100})
    return {"status": "completed"}
`,
  };
}

/**
 * Generate Dapr component YAML files
 */
export function generateDaprComponentsCode(): DaprCodeFile[] {
  return [
    {
      filename: "components/statestore.yaml",
      language: "yaml",
      content: `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: localhost:6379
    - name: redisPassword
      value: ""
    - name: actorStateStore
      value: "true"
`,
    },
    {
      filename: "components/pubsub.yaml",
      language: "yaml",
      content: `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: pubsub
spec:
  type: pubsub.redis
  version: v1
  metadata:
    - name: redisHost
      value: localhost:6379
    - name: redisPassword
      value: ""
`,
    },
  ];
}

/**
 * Get all code files for a Dapr workflow node
 */
export function getDaprNodeCodeFiles(node: WorkflowNode): DaprCodeFile[] {
  switch (node.type) {
    case "activity":
      return generateActivityCode(node);
    case "approval-gate":
      return generateApprovalGateCode(node);
    case "timer":
      return generateTimerCode(node);
    default:
      return [];
  }
}

/**
 * Get all code files for the full workflow
 */
export function getDaprWorkflowCodeFiles(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  workflowName?: string
): DaprCodeFile[] {
  const files: DaprCodeFile[] = [];

  // Full workflow definition
  files.push(
    generateWorkflowDefinitionCode(nodes, edges, workflowName)
  );

  // Individual activity files
  for (const node of nodes) {
    if (node.type === "activity") {
      files.push(...generateActivityCode(node));
    }
  }

  // Dapr components
  files.push(...generateDaprComponentsCode());

  return files;
}
