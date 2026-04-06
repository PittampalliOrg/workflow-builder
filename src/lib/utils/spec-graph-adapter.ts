/**
 * Converts a SW 1.0 spec into SvelteFlow nodes and edges
 * using the official @serverlessworkflow/sdk buildGraph function.
 */

import {
  buildGraph,
  type Graph,
  type GraphNode as SdkGraphNode,
  type GraphEdge as SdkGraphEdge,
  GraphNodeType,
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
    return convertGraph(graph, spec, metadata);
  } catch (err) {
    console.warn("[spec-to-graph] Failed to build graph:", err);
    return null;
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
  const doArray = (spec.do || []) as Array<Record<string, unknown>>;
  const taskMap = buildTaskMap(doArray);

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

  let y = 50;

  // Process nodes in sorted order
  for (const sdkNode of sortedNodes) {
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
        taskConfig: taskDef || {},
        status: "idle",
        enabled: true,
        // Apply cached catalog metadata (survives rebuilds)
        ...(taskMeta || {}),
      },
    };

    nodes.push(node);
    y += Y_SPACING;
  }

  // Process edges
  for (const sdkEdge of graph.edges) {
    const source = ID_MAP[sdkEdge.sourceId] || sdkEdge.sourceId;
    const target = ID_MAP[sdkEdge.destinationId] || sdkEdge.destinationId;
    const id = `${source}->${target}`;

    edges.push({
      id,
      source,
      target,
      ...(sdkEdge.label ? { label: sdkEdge.label } : {}),
    });
  }

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
