/**
 * Converts a SW 1.0 spec into SvelteFlow nodes and edges
 * using the official @serverlessworkflow/sdk buildGraph function.
 */

import { buildGraph, GraphNodeType } from "@serverlessworkflow/sdk/esm/index.esm.min.js";
import type {
  Graph,
  GraphNode as SdkGraphNode,
  GraphEdge as SdkGraphEdge,
} from "@serverlessworkflow/sdk";
import type { Node, Edge } from "@xyflow/svelte";
import { isAgentTaskConfig } from "$lib/types/agent-graph";

/** Map SDK node types to our workflow node types */
const NODE_TYPE_MAP: Record<string, string> = {
  [GraphNodeType.Start]: "start",
  [GraphNodeType.End]: "end",
  [GraphNodeType.Entry]: "start",
  [GraphNodeType.Exit]: "end",
  [GraphNodeType.Call]: "call",
  [GraphNodeType.Set]: "set",
  [GraphNodeType.Switch]: "switch",
  [GraphNodeType.Wait]: "wait",
  [GraphNodeType.Emit]: "emit",
  [GraphNodeType.Listen]: "listen",
  [GraphNodeType.For]: "for",
  [GraphNodeType.Fork]: "fork",
  [GraphNodeType.Try]: "try",
  [GraphNodeType.TryCatch]: "try",
  [GraphNodeType.Catch]: "try",
  [GraphNodeType.Do]: "do",
  [GraphNodeType.Run]: "run",
  [GraphNodeType.Raise]: "raise",
  [GraphNodeType.Root]: "do",
};

/** Map SDK entry/exit node IDs to our standard IDs */
const ID_MAP: Record<string, string> = {
  "root-entry-node": "__start__",
  "root-exit-node": "__end__",
};

/**
 * Convert a SW 1.0 spec to SvelteFlow nodes and edges.
 * Returns null if the spec is invalid or can't be parsed.
 */
export function specToGraph(
  spec: Record<string, unknown>,
  metadata?: Record<string, Record<string, unknown>>,
): { nodes: Node[]; edges: Edge[] } | null {
  try {
    const graph = buildGraph(spec as Parameters<typeof buildGraph>[0]);
    const converted = convertGraph(graph, spec, metadata);
    const doArray = getDoArray(spec);
    const renderedTaskCount = converted.nodes.filter((node) => node.type !== "start" && node.type !== "end").length;
    if (doArray.length > 0 && renderedTaskCount === 0) {
      return buildLinearGraphFromSpec(spec, metadata);
    }
    return converted;
  } catch (err) {
    console.warn("[spec-to-graph] Failed to build graph:", err);
    const fallback = buildLinearGraphFromSpec(spec, metadata);
    return fallback.nodes.length > 0 ? fallback : null;
  }
}

/**
 * Convert the SDK Graph to SvelteFlow nodes and edges.
 */
function convertGraph(
  graph: Graph,
  spec: Record<string, unknown>,
  metadata?: Record<string, Record<string, unknown>>,
): { nodes: Node[]; edges: Edge[] } {
  const doArray = getDoArray(spec);
  const taskMap = buildTaskMap(doArray);

  // Normalize the trigger-input schema across the two placements SW 1.0
  // specs use — legacy top-level `spec.input` and the newer
  // `spec.document['x-workflow-builder'].input.schema` (used by templates
  // like browser-use-web-navigator). The execute-dialog reads
  // `startNode.data.taskConfig.input.schema.document`, so we materialize
  // that shape here even when the raw spec uses the x-workflow-builder
  // placement.
  const doc = (spec.document ?? {}) as Record<string, unknown>;
  const xwb = (doc["x-workflow-builder"] ?? {}) as Record<string, unknown>;
  const xwbInput = (xwb.input ?? {}) as Record<string, unknown>;
  const xwbSchema = xwbInput.schema as Record<string, unknown> | undefined;
  const normalizedTriggerInput = spec.input
    ? (spec.input as Record<string, unknown>)
    : xwbSchema
      ? { format: "json", schema: { format: "json", document: xwbSchema } }
      : null;

  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // Position layout
  const X_CENTER = 250;
  const Y_SPACING = 150;

  // Sort nodes: entry first, then tasks in do-array order, then exit
  const taskOrder = new Map(
    doArray.map((entry, i) => [Object.keys(entry)[0], i]),
  );
  const sortedNodes = [...graph.nodes].sort((a, b) => {
    const aIsEntry =
      a.type === GraphNodeType.Start || a.type === GraphNodeType.Entry;
    const bIsEntry =
      b.type === GraphNodeType.Start || b.type === GraphNodeType.Entry;
    const aIsExit =
      a.type === GraphNodeType.End || a.type === GraphNodeType.Exit;
    const bIsExit =
      b.type === GraphNodeType.End || b.type === GraphNodeType.Exit;
    if (aIsEntry) return -1;
    if (bIsEntry) return 1;
    if (aIsExit) return 1;
    if (bIsExit) return -1;
    const aName = extractTaskName(a.id);
    const bName = extractTaskName(b.id);
    const aOrder = aName ? (taskOrder.get(aName) ?? 999) : 999;
    const bOrder = bName ? (taskOrder.get(bName) ?? 999) : 999;
    return aOrder - bOrder;
  });

  // Dedup BEFORE the position-assignment loop. The SDK's buildGraph can
  // emit the same logical node many times for workflows with `if:`
  // predicates (each branch retraces the node id). For our async-coding
  // workflow that's 9 tasks → 68 SDK nodes. If we let y increment per
  // SDK-node and dedup afterwards, the surviving nodes get sampled
  // y-positions from whatever index they happened to FIRST appear at,
  // scattering them vertically. Dedup first, then assign positions
  // sequentially.
  const seenSortedIds = new Set<string>();
  const uniqueSortedNodes = sortedNodes.filter((n) => {
    const mapped = ID_MAP[n.id] || n.id;
    if (seenSortedIds.has(mapped)) return false;
    seenSortedIds.add(mapped);
    return true;
  });

  let y = 50;

  // Process nodes in sorted order, assigning positions sequentially
  for (const sdkNode of uniqueSortedNodes) {
    const mappedId = ID_MAP[sdkNode.id] || sdkNode.id;
    const rawNodeType = NODE_TYPE_MAP[sdkNode.type] || "call";

    // Look up task config from the spec's do array
    const taskName = extractTaskName(sdkNode.id);
    const taskDef = taskName ? taskMap.get(taskName) : undefined;
    const nodeType = isAgentTaskConfig(taskDef) ? "agent" : rawNodeType;
    const label = sdkNode.label || extractTaskName(sdkNode.id) || nodeType;

    // Look up cached catalog metadata for this task
    const taskMeta = taskName ? metadata?.[taskName] : undefined;

    const node: Node = {
      id: mappedId,
      type: nodeType,
      position: { x: X_CENTER, y },
      data: {
        label:
          nodeType === "start" ? "Start" : nodeType === "end" ? "End" : label,
        type: nodeType,
        taskConfig:
          nodeType === "start" && normalizedTriggerInput
            ? { input: normalizedTriggerInput }
            : taskDef || {},
        status: "idle",
        enabled: true,
        // Apply cached catalog metadata (survives rebuilds)
        ...(taskMeta || {}),
      },
    };

    nodes.push(node);
    y += Y_SPACING;
  }

  // nodes is already dedup'd via the pre-loop filter; keep this set up
  // for legacy callers that pass through.
  const dedupedNodes = nodes;

  // Process edges (also dedup; same root cause)
  const seenEdgeIds = new Set<string>();
  for (const sdkEdge of graph.edges) {
    const source = ID_MAP[sdkEdge.sourceId] || sdkEdge.sourceId;
    const target = ID_MAP[sdkEdge.destinationId] || sdkEdge.destinationId;
    const id = `${source}->${target}`;
    if (seenEdgeIds.has(id)) continue;
    seenEdgeIds.add(id);

    edges.push({
      id,
      source,
      target,
      ...(sdkEdge.label ? { label: sdkEdge.label } : {}),
    });
  }

  return { nodes: dedupedNodes, edges };
}

function getDoArray(spec: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(spec.do) ? spec.do as Array<Record<string, unknown>> : [];
}

function inferNodeType(taskDef: Record<string, unknown> | undefined): string {
  if (isAgentTaskConfig(taskDef)) return "agent";
  if (!taskDef) return "call";
  if (taskDef.call) return "call";
  if (taskDef.set) return "set";
  if (taskDef.switch) return "switch";
  if (taskDef.wait) return "wait";
  if (taskDef.emit) return "emit";
  if (taskDef.listen) return "listen";
  if (taskDef.for) return "for";
  if (taskDef.fork) return "fork";
  if (taskDef.try) return "try";
  if (taskDef.do) return "do";
  if (taskDef.run) return "run";
  if (taskDef.raise) return "raise";
  return "call";
}

function buildLinearGraphFromSpec(
  spec: Record<string, unknown>,
  metadata?: Record<string, Record<string, unknown>>,
): { nodes: Node[]; edges: Edge[] } {
  const doArray = getDoArray(spec);
  if (doArray.length === 0) return { nodes: [], edges: [] };

  // Trigger input schema can live in two places on an SW 1.0 spec:
  //   (a) `spec.input` (the top-level SW-workflow-builder convention used
  //       by most older workflows), or
  //   (b) `spec.document["x-workflow-builder"].input` (used by workflows
  //       authored from JSON templates — e.g. the browser-use-web-navigator
  //       workflow). The execute-dialog reads `startNode.data.taskConfig
  //       .input.schema.document` for form rendering, so we normalize both
  //       shapes into a single `taskConfig.input` here.
  const doc = (spec.document ?? {}) as Record<string, unknown>;
  const xwb = (doc["x-workflow-builder"] ?? {}) as Record<string, unknown>;
  const xwbInput = (xwb.input ?? {}) as Record<string, unknown>;
  const xwbSchema = xwbInput.schema as Record<string, unknown> | undefined;
  const normalizedInput = spec.input
    ? (spec.input as Record<string, unknown>)
    : xwbSchema
      ? { format: "json", schema: { format: "json", document: xwbSchema } }
      : null;

  const nodes: Node[] = [{
    id: "__start__",
    type: "start",
    position: { x: 250, y: 50 },
    data: {
      label: "Start",
      type: "start",
      taskConfig: normalizedInput ? { input: normalizedInput } : {},
      status: "idle",
      enabled: true,
    },
  }];
  const edges: Edge[] = [];

  let previousId = "__start__";
  doArray.forEach((entry, index) => {
    const taskName = Object.keys(entry)[0];
    if (!taskName) return;
    const taskDef = entry[taskName] as Record<string, unknown> | undefined;
    const nodeType = inferNodeType(taskDef);
    const nodeId = `/do/${index}/${taskName}`;
    nodes.push({
      id: nodeId,
      type: nodeType,
      position: { x: 250, y: 200 + (index * 150) },
      data: {
        label: taskName,
        type: nodeType,
        taskConfig: taskDef || {},
        status: "idle",
        enabled: true,
        ...(metadata?.[taskName] || {}),
      },
    });
    edges.push({
      id: `${previousId}->${nodeId}`,
      source: previousId,
      target: nodeId,
    });
    previousId = nodeId;
  });

  nodes.push({
    id: "__end__",
    type: "end",
    position: { x: 250, y: 200 + (doArray.length * 150) },
    data: {
      label: "End",
      type: "end",
      taskConfig: {},
      status: "idle",
      enabled: true,
    },
  });
  edges.push({
    id: `${previousId}->__end__`,
    source: previousId,
    target: "__end__",
  });

  return { nodes, edges };
}

/**
 * Build a map from task name to task definition from the do array.
 */
function buildTaskMap(
  doArray: Array<Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const entry of doArray) {
    const taskName = Object.keys(entry)[0];
    if (taskName) {
      map.set(taskName, entry[taskName] as Record<string, unknown>);
    }
  }
  return map;
}

/**
 * Extract the task name from an SDK node ID like "/do/0/fetch-data".
 */
function extractTaskName(nodeId: string): string | null {
  const parts = nodeId.split("/");
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

/**
 * Create a minimal valid SW 1.0 spec with just document and empty do array.
 */
export function createEmptySpec(name: string): Record<string, unknown> {
  return {
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder",
      name:
        name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-") || "untitled",
      version: "1.0.0",
      title: name,
    },
    do: [],
  };
}
