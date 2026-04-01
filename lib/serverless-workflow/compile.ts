/**
 * Compile: Visual graph (nodes + edges) -> CNCF Serverless Workflow 1.0 JSON
 *
 * Takes @xyflow/react nodes and edges and produces a valid SW 1.0 Workflow document.
 */

import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./graph-types";
import type {
  CallFunctionTask,
  CallHTTPTask,
  DoTask,
  EmitTask,
  FlowDirective,
  ForTask,
  ForkTask,
  ListenTask,
  RaiseTask,
  RunTask,
  SetTask,
  SwitchTask,
  Task,
  TaskItem,
  TryTask,
  WaitTask,
  Workflow,
  WorkflowDocument,
} from "./types";
import { SW_DSL_VERSION } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function topoSort(
  nodeIds: string[],
  edges: WorkflowEdge[],
): string[] {
  const idSet = new Set(nodeIds);
  const inDeg = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDeg.set(id, 0);
    outgoing.set(id, []);
  }

  for (const e of edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target)) continue;
    outgoing.get(e.source)!.push(e.target);
    inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
  }

  const queue = nodeIds
    .filter((id) => (inDeg.get(id) || 0) === 0)
    .sort();
  const result: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    result.push(id);
    for (const n of (outgoing.get(id) || []).sort()) {
      const next = (inDeg.get(n) || 0) - 1;
      inDeg.set(n, next);
      if (next === 0) {
        queue.push(n);
        queue.sort();
      }
    }
  }

  return result.length === nodeIds.length
    ? result
    : [...nodeIds].sort();
}

/**
 * Extract the task name from a node ID.
 * Node IDs follow the pattern: /parentPrefix/taskName or just the node id.
 */
function nodeIdToTaskName(nodeId: string): string {
  const parts = nodeId.split("/");
  return parts[parts.length - 1] || nodeId;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the task type from a node, supporting both SW 1.0 and legacy DB fields */
function resolveNodeTaskType(node: WorkflowNode): string {
  return (
    node.data.taskType
    || (node.data as unknown as { type?: string }).type
    || node.type
    || "set"
  );
}

// ---------------------------------------------------------------------------
// Node -> Task conversion
// ---------------------------------------------------------------------------

function nodeToTask(node: WorkflowNode): Task {
  // Support both taskConfig (new SW 1.0 graph-types) and config (legacy DB storage)
  const config = node.data.taskConfig
    || (node.data as unknown as { config?: Record<string, unknown> }).config
    || {};
  const taskType = node.data.taskType
    || (node.data as unknown as { type?: string }).type
    || node.type;

  switch (taskType) {
    case "call": {
      const callProtocol = config.call as string;
      if (callProtocol === "http") {
        return {
          call: "http",
          with: config.with as CallHTTPTask["with"],
          ...(config.if ? { if: config.if as string } : {}),
          ...(config.input ? { input: config.input as Task["input"] } : {}),
          ...(config.output ? { output: config.output as Task["output"] } : {}),
          ...(config.timeout ? { timeout: config.timeout as Task["timeout"] } : {}),
          ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
        } as CallHTTPTask;
      }
      return {
        call: callProtocol || "http",
        with: config.with as Record<string, unknown>,
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as CallFunctionTask;
    }

    case "set":
      return {
        set: (config.set || {}) as Record<string, unknown>,
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as SetTask;

    case "switch":
      return {
        switch: (config.switch || []) as SwitchTask["switch"],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as SwitchTask;

    case "wait":
      return {
        wait: config.wait || config.duration || "PT0S",
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as WaitTask;

    case "emit":
      return {
        emit: (config.emit || { event: { with: { type: "" } } }) as EmitTask["emit"],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as EmitTask;

    case "listen":
      return {
        listen: (config.listen || { to: {} }) as ListenTask["listen"],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as ListenTask;

    case "for":
      return {
        for: (config.for || { each: "item", in: ".items" }) as ForTask["for"],
        while: config.while as string | undefined,
        do: (config.do || []) as TaskItem[],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as ForTask;

    case "fork":
      return {
        fork: (config.fork || { branches: [] }) as ForkTask["fork"],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as ForkTask;

    case "try":
      return {
        try: (config.try || []) as TaskItem[],
        catch: (config.catch || {}) as TryTask["catch"],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as TryTask;

    case "raise":
      return {
        raise: (config.raise || { error: { type: "", status: 500 } }) as RaiseTask["raise"],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as RaiseTask;

    case "run":
      return {
        run: (config.run || {}) as RunTask["run"],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as RunTask;

    case "do":
      return {
        do: (config.do || []) as TaskItem[],
        ...(config.if ? { if: config.if as string } : {}),
        ...(config.metadata ? { metadata: config.metadata as Record<string, unknown> } : {}),
      } as DoTask;

    default:
      // Fallback: treat unknown types as a set task with metadata
      return {
        set: {},
        metadata: { originalType: taskType, ...config },
      } as SetTask;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompileOptions {
  namespace?: string;
  name?: string;
  version?: string;
  title?: string;
  summary?: string;
}

export function compileGraphToWorkflow(
  graph: WorkflowGraph,
  options: CompileOptions = {},
): Workflow {
  const { nodes, edges } = graph;

  // Find start and end nodes
  const startNode = nodes.find((n) => resolveNodeTaskType(n) === "start");
  const endNode = nodes.find((n) => resolveNodeTaskType(n) === "end");

  // Get task nodes (everything except start/end)
  const taskNodes = nodes.filter(
    (n) => resolveNodeTaskType(n) !== "start" && resolveNodeTaskType(n) !== "end",
  );

  // Get edges between task nodes (exclude start/end connections)
  const startId = startNode?.id || "__start__";
  const endId = endNode?.id || "__end__";
  const taskEdges = edges.filter(
    (e) => e.source !== startId && e.target !== endId,
  );

  // Topologically sort task nodes
  const sortedIds = topoSort(
    taskNodes.map((n) => n.id),
    taskEdges,
  );

  const nodeById = new Map(taskNodes.map((n) => [n.id, n]));

  // Build outgoing edge map for `then` directives
  const outgoingEdges = new Map<string, WorkflowEdge[]>();
  for (const e of taskEdges) {
    const list = outgoingEdges.get(e.source) || [];
    list.push(e);
    outgoingEdges.set(e.source, list);
  }

  // Convert sorted nodes to TaskItems
  const taskItems: TaskItem[] = [];

  for (let i = 0; i < sortedIds.length; i++) {
    const nodeId = sortedIds[i];
    const node = nodeById.get(nodeId);
    if (!node) continue;

    const taskName = nodeIdToTaskName(nodeId);
    const task = nodeToTask(node);

    // Determine `then` directive from outgoing edges
    const outs = outgoingEdges.get(nodeId) || [];
    const nextInSequence = sortedIds[i + 1];

    if (resolveNodeTaskType(node) === "switch") {
      // Switch tasks encode flow in their cases, don't add then
    } else if (outs.length === 0) {
      // No outgoing edges: terminal task, implicit end
    } else if (outs.length === 1 && outs[0].target === nextInSequence) {
      // Next in sequence: no explicit then needed (default is "continue")
    } else if (outs.length === 1) {
      // Jump to non-sequential target
      const targetName = nodeIdToTaskName(outs[0].target);
      task.then = targetName;
    }

    taskItems.push({ [taskName]: task });
  }

  // Build document from start node config or options
  const startConfig = startNode?.data.taskConfig
    || (startNode?.data as unknown as { config?: Record<string, unknown> })?.config
    || {};
  const existingDoc = startConfig.document as Partial<WorkflowDocument> | undefined;

  const document: WorkflowDocument = {
    dsl: SW_DSL_VERSION,
    namespace: options.namespace || existingDoc?.namespace || "default",
    name: options.name || existingDoc?.name || "untitled",
    version: options.version || existingDoc?.version || "0.0.1",
    ...(options.title || existingDoc?.title
      ? { title: options.title || existingDoc?.title }
      : {}),
    ...(options.summary || existingDoc?.summary
      ? { summary: options.summary || existingDoc?.summary }
      : {}),
  };

  const workflow: Workflow = {
    document,
    do: taskItems.length > 0 ? taskItems : [{ noop: { set: {} } as SetTask }],
  };

  // Carry over use definitions from start node
  if (startConfig.use) {
    workflow.use = startConfig.use as Workflow["use"];
  }

  // Carry over input from start node
  if (startConfig.input) {
    workflow.input = startConfig.input as Workflow["input"];
  }

  // Carry over output from end node
  const endConfig = endNode?.data.taskConfig
    || (endNode?.data as unknown as { config?: Record<string, unknown> })?.config
    || {};
  if (endConfig.output) {
    workflow.output = endConfig.output as Workflow["output"];
  }

  return workflow;
}
