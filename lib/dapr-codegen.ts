/**
 * Dapr Code Generation
 *
 * Generates TypeScript code for Dapr workflow orchestration.
 * Aligns with the Vercel Workflow DevKit pattern while using Dapr primitives.
 *
 * Uses the Dapr TypeScript SDK:
 * - WorkflowContext for orchestration
 * - callActivity() for service invocations
 * - waitForExternalEvent() for human-in-the-loop gates
 * - createTimer() for delays and timeouts
 * - whenAny() for racing events
 */

import { getDaprActivity } from "./dapr-activity-registry";
import type { WorkflowNode, WorkflowEdge } from "./workflow-store";
import type {
  WorkflowDefinition,
  SerializedNode,
  SerializedEdge,
} from "./workflow-definition";

export type DaprCodeFile = {
  filename: string;
  language: string; // "typescript" | "yaml" | "json"
  content: string;
};

/**
 * Convert a string to camelCase for TypeScript function names
 */
function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, chr) => chr.toUpperCase())
    .replace(/^[A-Z]/, (chr) => chr.toLowerCase())
    .replace(/[^a-zA-Z0-9]/g, "");
}

/**
 * Generate code for a single activity node
 */
export function generateActivityCode(node: WorkflowNode): DaprCodeFile[] {
  const activityName =
    (node.data.config?.activityName as string) || "unknown_activity";
  const activity = getDaprActivity(activityName);
  const files: DaprCodeFile[] = [];

  const functionName = toCamelCase(activityName);

  if (activity) {
    // Generate TypeScript activity function
    const inputParams = activity.inputFields
      .map((f) => `  ${f.key}: ${f.type === "number" ? "number" : "string"};`)
      .join("\n");

    const outputFields = activity.outputFields
      .map((f) => `  /** ${f.description} */\n  ${f.field}: unknown;`)
      .join("\n");

    files.push({
      filename: `activities/${activityName}.ts`,
      language: "typescript",
      content: `/**
 * ${activity.label}
 * ${activity.description}
 */
import { WorkflowActivityContext } from "@dapr/dapr";

export type ${functionName}Input = {
${inputParams || "  // No input parameters"}
};

export type ${functionName}Output = {
${outputFields || "  status: string;"}
};

/**
 * Activity: ${activity.label}
${activity.serviceName ? ` * Service: ${activity.serviceName}` : ""}
${activity.serviceMethod ? ` * Method: ${activity.serviceMethod}` : ""}
${activity.timeout ? ` * Timeout: ${activity.timeout}s` : ""}
 */
export async function ${functionName}(
  ctx: WorkflowActivityContext,
  input: ${functionName}Input
): Promise<${functionName}Output> {
${
  activity.serviceName
    ? `  // Invoke target service via Dapr service invocation
  // const client = new DaprClient();
  // const result = await client.invoker.invoke(
  //   "${activity.serviceName}",
  //   "${activity.serviceMethod || "invoke"}",
  //   HttpMethod.POST,
  //   input
  // );`
    : `  // Process input and return result`
}

  return { status: "completed" };
}
`,
    });
  } else {
    files.push({
      filename: `activities/${activityName}.ts`,
      language: "typescript",
      content: `// Activity: ${activityName}
// No registry entry found for this activity

import { WorkflowActivityContext } from "@dapr/dapr";

export async function ${functionName}(
  ctx: WorkflowActivityContext,
  input: Record<string, unknown>
): Promise<{ status: string }> {
  return { status: "completed" };
}
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
      filename: "workflow/approval-gate.ts",
      language: "typescript",
      content: `/**
 * Approval Gate: ${node.data.label || "Plan Review"}
 * Waits for external approval event with timeout.
 *
 * This code is embedded within the workflow generator function.
 */
import { WorkflowContext, whenAny } from "@dapr/dapr";

// Inside the workflow generator function:
async function* approvalGate(ctx: WorkflowContext) {
  // Wait for approval event with timeout
  const approvalEvent = ctx.waitForExternalEvent("${eventName}");
  const timeoutEvent = ctx.createTimer(${timeoutHours} * 60 * 60); // ${timeoutHours} hours in seconds

  // Race between approval and timeout
  const winner = yield whenAny([approvalEvent, timeoutEvent]);

  if (winner === timeoutEvent) {
    // Timeout reached - auto-reject
    return { approved: false, reason: "Timed out after ${timeoutHours} hours" };
  }

  // Process approval result
  const result = approvalEvent.getResult() as { approved?: boolean; reason?: string };
  return {
    approved: result?.approved ?? false,
    reason: result?.reason ?? "",
  };
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
      filename: "workflow/timer.ts",
      language: "typescript",
      content: `/**
 * Timer: ${node.data.label || "Delay"}
 * Creates a timer delay in the workflow.
 */
import { WorkflowContext } from "@dapr/dapr";

// Inside the workflow generator function:
async function* timerStep(ctx: WorkflowContext) {
  yield ctx.createTimer(${durationSeconds}); // ${durationSeconds} seconds
}
`,
    },
  ];
}

/**
 * Generate the full workflow definition TypeScript code
 */
export function generateWorkflowDefinitionCode(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  workflowName = "plannerWorkflow"
): DaprCodeFile {
  const activityNodes = nodes.filter((n) => n.type === "activity");
  const approvalNodes = nodes.filter((n) => n.type === "approval-gate");
  const _timerNodes = nodes.filter((n) => n.type === "timer");

  // Build imports for activities
  const activityImports = activityNodes
    .map((n) => {
      const name =
        (n.data.config?.activityName as string) || "unknown_activity";
      const fnName = toCamelCase(name);
      return `import { ${fnName} } from "./activities/${name}";`;
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

  // Track variable names for template references
  const nodeVarNames = new Map<string, string>();
  let varCounter = 0;

  for (const node of orderedNodes) {
    if (node.type === "activity") {
      const actName =
        (node.data.config?.activityName as string) || "unknown_activity";
      const activity = getDaprActivity(actName);
      const fnName = toCamelCase(actName);
      const varName = `result${varCounter++}`;
      nodeVarNames.set(node.id, varName);

      // Build input object from node config
      const inputFields: string[] = [];
      if (node.data.config) {
        const config = node.data.config as Record<string, unknown>;
        for (const [key, value] of Object.entries(config)) {
          if (key === "activityName") continue;
          if (value !== undefined && value !== null && value !== "") {
            if (typeof value === "string") {
              inputFields.push(`      ${key}: \`${value.replace(/`/g, "\\`")}\`,`);
            } else if (typeof value === "number" || typeof value === "boolean") {
              inputFields.push(`      ${key}: ${value},`);
            } else {
              inputFields.push(`      ${key}: ${JSON.stringify(value)},`);
            }
          }
        }
      }

      const inputStr = inputFields.length > 0
        ? `{\n${inputFields.join("\n")}\n    }`
        : "{ ...input }";

      steps.push(
        `  // ${node.data.label || activity?.label || actName}
  const ${varName} = yield ctx.callActivity(${fnName}, ${inputStr});`
      );
    } else if (node.type === "approval-gate") {
      const eventName =
        (node.data.config?.eventName as string) || "approval_event";
      const timeoutHours =
        (node.data.config?.timeoutHours as number) || 24;
      const timeoutSeconds = timeoutHours * 60 * 60;

      steps.push(
        `  // ${node.data.label || "Approval Gate"}
  ctx.setCustomStatus({ phase: "awaiting_approval", progress: 50 });
  const approvalEvent = ctx.waitForExternalEvent("${eventName}");
  const timeoutEvent = ctx.createTimer(${timeoutSeconds}); // ${timeoutHours} hours
  const winner = yield whenAny([approvalEvent, timeoutEvent]);

  if (winner === timeoutEvent) {
    throw new Error("Approval timed out after ${timeoutHours} hours");
  }

  const approval = approvalEvent.getResult() as { approved?: boolean; reason?: string };
  if (!approval?.approved) {
    throw new Error("Plan rejected: " + (approval?.reason ?? "No reason provided"));
  }`
      );
    } else if (node.type === "timer") {
      const seconds =
        (node.data.config?.durationSeconds as number) || 60;
      steps.push(
        `  // ${node.data.label || "Timer"}
  yield ctx.createTimer(${seconds}); // ${seconds} seconds`
      );
    }
  }

  const body = steps.join("\n\n");

  // Determine if we need whenAny import
  const needsWhenAny = approvalNodes.length > 0;

  return {
    filename: `workflow/${workflowName}.ts`,
    language: "typescript",
    content: `/**
 * Dapr Workflow: ${workflowName}
 * Auto-generated from visual workflow builder.
 *
 * This workflow uses the Dapr TypeScript SDK for orchestration.
 * It follows the same patterns as Vercel Workflow DevKit but with Dapr primitives.
 */
import {
  WorkflowContext,
  WorkflowRuntime,
  DaprWorkflowClient,
${needsWhenAny ? '  whenAny,\n' : ''}  TWorkflow,
} from "@dapr/dapr";
${activityImports ? `\n${activityImports}` : ""}

export type WorkflowInput = {
  featureRequest?: string;
  cwd?: string;
  [key: string]: unknown;
};

export type WorkflowOutput = {
  status: string;
  [key: string]: unknown;
};

/**
 * ${workflowName}
 *
 * Orchestrates the workflow pipeline using Dapr's durable workflow engine.
 * Each activity is called via ctx.callActivity() and executed by the Dapr sidecar.
 */
export const ${workflowName}: TWorkflow = async function* (
  ctx: WorkflowContext,
  input: WorkflowInput
): AsyncGenerator<unknown, WorkflowOutput, unknown> {
  "use workflow";

  ctx.setCustomStatus({ phase: "started", progress: 0 });

${body || "  // No workflow steps defined"}

  ctx.setCustomStatus({ phase: "completed", progress: 100 });
  return { status: "completed" };
};

// ─── Runtime Registration ─────────────────────────────────────────────────────

/**
 * Register and start the workflow runtime
 */
export async function startWorkflowRuntime(
  daprHost = "localhost",
  daprPort = "50001"
): Promise<WorkflowRuntime> {
  const workflowRuntime = new WorkflowRuntime({
    daprHost,
    daprPort,
  });

  // Register workflow
  workflowRuntime.registerWorkflow(${workflowName});

  // Register activities
${activityNodes
  .map((n) => {
    const name = (n.data.config?.activityName as string) || "unknown_activity";
    const fnName = toCamelCase(name);
    return `  workflowRuntime.registerActivity(${fnName});`;
  })
  .join("\n") || "  // No activities to register"}

  await workflowRuntime.start();
  console.log("Workflow runtime started");

  return workflowRuntime;
}

/**
 * Schedule a new workflow instance
 */
export async function scheduleWorkflow(
  input: WorkflowInput,
  instanceId?: string,
  daprHost = "localhost",
  daprPort = "50001"
): Promise<string> {
  const client = new DaprWorkflowClient({
    daprHost,
    daprPort,
  });

  const id = await client.scheduleNewWorkflow(${workflowName}, input, instanceId);
  console.log(\`Scheduled workflow instance: \${id}\`);

  return id;
}

/**
 * Raise an event to a running workflow (e.g., for approval gates)
 */
export async function raiseWorkflowEvent(
  instanceId: string,
  eventName: string,
  eventPayload: unknown,
  daprHost = "localhost",
  daprPort = "50001"
): Promise<void> {
  const client = new DaprWorkflowClient({
    daprHost,
    daprPort,
  });

  await client.raiseEvent(instanceId, eventName, eventPayload);
  console.log(\`Raised event "\${eventName}" for workflow \${instanceId}\`);
}
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
 * Generate package.json for the workflow project
 */
export function generatePackageJson(workflowName: string): DaprCodeFile {
  return {
    filename: "package.json",
    language: "json",
    content: JSON.stringify(
      {
        name: workflowName,
        version: "1.0.0",
        description: `Dapr workflow: ${workflowName}`,
        main: `workflow/${workflowName}.ts`,
        scripts: {
          start: `npx ts-node workflow/${workflowName}.ts`,
          build: "npx tsc",
        },
        dependencies: {
          "@dapr/dapr": "^3.0.0",
        },
        devDependencies: {
          typescript: "^5.0.0",
          "ts-node": "^10.9.0",
          "@types/node": "^20.0.0",
        },
      },
      null,
      2
    ),
  };
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
  const name = workflowName || "plannerWorkflow";

  // Full workflow definition
  files.push(generateWorkflowDefinitionCode(nodes, edges, name));

  // Individual activity files
  for (const node of nodes) {
    if (node.type === "activity") {
      files.push(...generateActivityCode(node));
    }
  }

  // Package.json
  files.push(generatePackageJson(name));

  // Dapr components
  files.push(...generateDaprComponentsCode());

  return files;
}

// ─── Workflow Definition Generation ─────────────────────────────────────────────

/**
 * Topologically sort nodes based on edge dependencies
 * Returns an array of node IDs in execution order
 */
export function topologicalSort(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[]
): string[] {
  // Build adjacency list
  const edgesBySource = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  // Initialize all nodes with 0 in-degree
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    edgesBySource.set(node.id, []);
  }

  // Build graph
  for (const edge of edges) {
    const targets = edgesBySource.get(edge.source) || [];
    targets.push(edge.target);
    edgesBySource.set(edge.source, targets);
    inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
  }

  // Find all nodes with 0 in-degree (start with trigger nodes)
  const queue: string[] = [];
  for (const [nodeId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(nodeId);
    }
  }

  const result: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const node = nodes.find((n) => n.id === nodeId);

    // Skip trigger and add nodes in execution order
    if (node && node.type !== "trigger" && node.type !== "add") {
      result.push(nodeId);
    }

    // Process neighbors
    const neighbors = edgesBySource.get(nodeId) || [];
    for (const neighbor of neighbors) {
      const newDegree = (inDegree.get(neighbor) || 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  return result;
}

/**
 * Serialize a WorkflowNode to SerializedNode format
 */
function serializeNode(node: WorkflowNode): SerializedNode {
  return {
    id: node.id,
    type: node.data.type,
    label: node.data.label,
    description: node.data.description,
    enabled: node.data.enabled !== false, // Default to true
    position: node.position,
    config: node.data.config || {},
  };
}

/**
 * Serialize a WorkflowEdge to SerializedEdge format
 */
function serializeEdge(edge: WorkflowEdge): SerializedEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
  };
}

/**
 * Generate a complete WorkflowDefinition from nodes and edges
 * This is the JSON format used by the TypeScript orchestrator
 */
export function generateWorkflowDefinition(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  workflowId: string,
  workflowName?: string,
  metadata?: WorkflowDefinition["metadata"]
): WorkflowDefinition {
  const now = new Date().toISOString();

  // Filter out 'add' nodes (UI placeholder nodes)
  const executableNodes = nodes.filter((n) => n.type !== "add");

  // Serialize nodes and edges
  const serializedNodes = executableNodes.map(serializeNode);
  const serializedEdges = edges.filter(
    (e) =>
      executableNodes.some((n) => n.id === e.source) &&
      executableNodes.some((n) => n.id === e.target)
  ).map(serializeEdge);

  // Get execution order
  const executionOrder = topologicalSort(executableNodes, edges);

  return {
    id: workflowId,
    name: workflowName || `workflow-${workflowId}`,
    version: "1.0.0",
    createdAt: now,
    updatedAt: now,
    nodes: serializedNodes,
    edges: serializedEdges,
    executionOrder,
    metadata,
  };
}

/**
 * Generate workflow definition as a JSON code file
 */
export function generateWorkflowDefinitionJson(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  workflowId: string,
  workflowName?: string
): DaprCodeFile {
  const definition = generateWorkflowDefinition(
    nodes,
    edges,
    workflowId,
    workflowName
  );

  return {
    filename: `definitions/${workflowId}.json`,
    language: "json",
    content: JSON.stringify(definition, null, 2),
  };
}
