/**
 * Workflow Executor
 *
 * Executes workflow nodes by calling the activity-executor service.
 * This provides a direct execution path for visual workflows without
 * requiring the planner-dapr-agent.
 */

import type { WorkflowEdge, WorkflowNode } from "./workflow-store";

// Activity executor service URL
const ACTIVITY_EXECUTOR_URL =
  process.env.ACTIVITY_EXECUTOR_URL ||
  "http://activity-executor.activity-executor.svc.cluster.local:8080";

export type NodeOutput = {
  nodeId: string;
  label: string;
  data: unknown;
  success: boolean;
  error?: string;
  duration_ms: number;
};

export type WorkflowExecutionResult = {
  success: boolean;
  outputs: Record<string, NodeOutput>;
  error?: string;
  duration_ms: number;
};

export type ExecutionCallback = (
  nodeId: string,
  status: "running" | "completed" | "error",
  output?: NodeOutput
) => void;

/**
 * Build execution order from nodes and edges using topological sort
 */
function buildExecutionOrder(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): WorkflowNode[] {
  // Build adjacency list and in-degree count
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  // Initialize
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  // Build graph from edges
  for (const edge of edges) {
    const targets = adjacency.get(edge.source) || [];
    targets.push(edge.target);
    adjacency.set(edge.source, targets);

    const count = inDegree.get(edge.target) || 0;
    inDegree.set(edge.target, count + 1);
  }

  // Kahn's algorithm for topological sort
  const queue: string[] = [];
  const result: WorkflowNode[] = [];
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Start with nodes that have no incoming edges
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) {
      continue;
    }

    const node = nodeMap.get(nodeId);
    if (node) {
      result.push(node);
    }

    const neighbors = adjacency.get(nodeId) || [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) || 0) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return result;
}

/**
 * Get the activity ID for a node
 */
function getActivityId(node: WorkflowNode): string | null {
  const data = node.data as Record<string, unknown>;
  const config = data.config as Record<string, unknown> | undefined;

  // Check for actionType in config (e.g., "ai-gateway/generate-text")
  if (config?.actionType && typeof config.actionType === "string") {
    return config.actionType;
  }

  // Check for actionId directly on data
  if (data.actionId && typeof data.actionId === "string") {
    return data.actionId;
  }

  // Check for service + action combination in config
  if (config?.service && config?.action) {
    return `${config.service}/${config.action}`;
  }

  return null;
}

function parseConnectionExternalIdFromAuth(
  authValue: unknown
): string | undefined {
  if (typeof authValue !== "string") {
    return;
  }

  const match = authValue.match(/\{\{connections\[['"]([^'"]+)['"]\]\}\}/);
  return match?.[1];
}

/**
 * Get node configuration/input
 */
function getNodeInput(node: WorkflowNode): Record<string, unknown> {
  const data = node.data as Record<string, unknown>;
  const config = (data.config as Record<string, unknown>) || {};

  // Clone config and exclude metadata fields
  const input: Record<string, unknown> = {};
  const excludedFields = new Set(["actionType", "auth"]);

  for (const [key, value] of Object.entries(config)) {
    if (!excludedFields.has(key)) {
      input[key] = value;
    }
  }

  // Also check for fields directly on data (legacy format)
  const commonFields = [
    "prompt",
    "model",
    "outputFormat",
    "message",
    "channel",
    "text",
    "url",
    "body",
    "headers",
  ];

  for (const field of commonFields) {
    if (data[field] !== undefined && input[field] === undefined) {
      input[field] = data[field];
    }
  }

  return input;
}

/**
 * Execute a single node by calling the activity-executor service
 */
async function executeNode(
  node: WorkflowNode,
  executionId: string,
  workflowId: string,
  nodeOutputs: Record<string, { label: string; data: unknown }>
): Promise<NodeOutput> {
  const activityId = getActivityId(node);
  const data = node.data as Record<string, unknown>;
  const label = (data.label as string) || node.id;

  if (!activityId) {
    // Skip non-action nodes (triggers, etc.)
    return {
      nodeId: node.id,
      label,
      data: { skipped: true, reason: "Not an action node" },
      success: true,
      duration_ms: 0,
    };
  }

  const input = getNodeInput(node);
  const config = (data.config as Record<string, unknown>) || {};
  const connectionExternalId =
    parseConnectionExternalIdFromAuth(config.auth) ||
    parseConnectionExternalIdFromAuth(data.auth);

  const requestBody = {
    activity_id: activityId,
    execution_id: executionId,
    workflow_id: workflowId,
    node_id: node.id,
    node_name: label,
    input,
    node_outputs: nodeOutputs,
    connection_external_id: connectionExternalId,
  };

  try {
    const response = await fetch(`${ACTIVITY_EXECUTOR_URL}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const result = await response.json();

    return {
      nodeId: node.id,
      label,
      data: result.data,
      success: result.success,
      error: result.error,
      duration_ms: result.duration_ms || 0,
    };
  } catch (error) {
    return {
      nodeId: node.id,
      label,
      data: null,
      success: false,
      error: error instanceof Error ? error.message : "Failed to execute node",
      duration_ms: 0,
    };
  }
}

/**
 * Execute a workflow by running nodes in topological order
 */
export async function executeWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  executionId: string,
  workflowId: string,
  onNodeUpdate?: ExecutionCallback
): Promise<WorkflowExecutionResult> {
  const startTime = Date.now();
  const outputs: Record<string, NodeOutput> = {};
  const nodeOutputs: Record<string, { label: string; data: unknown }> = {};

  try {
    // Build execution order
    const orderedNodes = buildExecutionOrder(nodes, edges);

    // Execute nodes in order
    for (const node of orderedNodes) {
      const nodeType = node.type;

      // Skip trigger nodes
      if (nodeType === "trigger" || nodeType === "manual-trigger") {
        continue;
      }

      // Notify start
      if (onNodeUpdate) {
        onNodeUpdate(node.id, "running");
      }

      // Execute node
      const output = await executeNode(
        node,
        executionId,
        workflowId,
        nodeOutputs
      );

      outputs[node.id] = output;

      // Store output for template resolution in subsequent nodes
      nodeOutputs[node.id] = {
        label: output.label,
        data: output.data,
      };

      // Notify completion
      if (onNodeUpdate) {
        onNodeUpdate(node.id, output.success ? "completed" : "error", output);
      }

      // Stop on error (unless it's a skipped node)
      if (
        !(output.success || (output.data as Record<string, unknown>)?.skipped)
      ) {
        return {
          success: false,
          outputs,
          error: `Node "${output.label}" failed: ${output.error}`,
          duration_ms: Date.now() - startTime,
        };
      }
    }

    return {
      success: true,
      outputs,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      outputs,
      error:
        error instanceof Error ? error.message : "Workflow execution failed",
      duration_ms: Date.now() - startTime,
    };
  }
}

/**
 * Check if activity-executor service is available
 */
export async function checkActivityExecutorHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${ACTIVITY_EXECUTOR_URL}/health`, {
      method: "GET",
    });
    return response.ok;
  } catch {
    return false;
  }
}
