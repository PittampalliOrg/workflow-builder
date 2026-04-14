import { normalizeAgentTaskConfig } from "$lib/types/agent-graph";
import {
  compileSandboxPolicies,
  withDocumentSandboxPolicy,
  DEFAULT_NEW_AGENT_SANDBOX_POLICY,
} from "$lib/workflows/sandbox-policy";

/**
 * Builds a CNCF Serverless Workflow 1.0 spec from visual graph nodes and edges.
 * Converts the SvelteFlow node/edge graph into the linear `do` array format
 * expected by the workflow-orchestrator.
 */

interface GraphNode {
  id: string;
  type?: string;
  data?: {
    label?: string;
    type?: string;
    taskConfig?: Record<string, unknown>;
    catalogFunction?: { pieceName?: string; actionName?: string };
    [key: string]: unknown;
  };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
}

/**
 * Build a SW 1.0 spec from nodes and edges.
 * Walks the graph from __start__ to __end__ following edges,
 * and builds the `do` array from each node's taskConfig.
 */
export function buildSpecFromGraph(
  workflowName: string,
  nodes: GraphNode[],
  edges: GraphEdge[],
): Record<string, unknown> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const edgesBySource = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const list = edgesBySource.get(edge.source) || [];
    list.push(edge);
    edgesBySource.set(edge.source, list);
  }

  // Walk from start to end, building the do array
  const doArray: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  let currentId = "__start__";

  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const node = nodeMap.get(currentId);
    const nodeType = (node?.data?.type || node?.type || "unknown") as string;

    // Skip start/end nodes — they're structural, not tasks
    if (nodeType !== "start" && nodeType !== "end" && node) {
      const taskName = sanitizeTaskName(
        (node.data?.label as string) || node.id,
      );
      const taskConfig = (node.data?.taskConfig || {}) as Record<
        string,
        unknown
      >;

      // Build the task entry based on node type
      const task = buildTask(nodeType, taskConfig, node);
      if (task) {
        doArray.push({ [taskName]: task });
      }
    }

    // Follow the first outgoing edge
    const outEdges = edgesBySource.get(currentId) || [];
    if (outEdges.length > 0) {
      currentId = outEdges[0].target;
    } else {
      break;
    }
  }

  const spec = withDocumentSandboxPolicy({
    document: {
      dsl: "1.0.0",
      namespace: "workflow-builder",
      name: sanitizeTaskName(workflowName),
      version: "1.0.0",
      title: workflowName,
    },
    do: doArray,
  }, DEFAULT_NEW_AGENT_SANDBOX_POLICY);
  return compileSandboxPolicies(spec);
}

/**
 * Build a single task from node type and config.
 */
function buildTask(
  nodeType: string,
  taskConfig: Record<string, unknown>,
  node: GraphNode,
): Record<string, unknown> | null {
  switch (nodeType) {
    case "call": {
      // If taskConfig already has 'call' key (from catalog), use as-is
      if (taskConfig.call) {
        return taskConfig;
      }
      // Otherwise build from function field
      const fn = taskConfig.function as string | undefined;
      if (fn) {
        return {
          call: fn,
          with: taskConfig.arguments || {},
        };
      }
      // Generic HTTP call fallback
      return {
        call: "http",
        with: {
          method: taskConfig.method || "GET",
          endpoint: taskConfig.url || taskConfig.endpoint || "",
        },
      };
    }
    case "agent":
      return normalizeAgentTaskConfig(
        taskConfig,
        typeof node.data?.label === "string" ? node.data.label : node.id,
      );
    case "set":
      return {
        set: taskConfig.variables || taskConfig,
      };
    case "switch":
      return {
        switch: (taskConfig.conditions || []) as unknown[],
      };
    case "wait":
      return {
        wait: {
          duration: taskConfig.duration || "PT0S",
        },
      };
    case "emit":
      return {
        emit: {
          event: taskConfig.event || {},
        },
      };
    case "listen":
      return {
        listen: {
          to: taskConfig.event || {},
        },
      };
    case "for":
      return {
        for: {
          each: taskConfig.each || "item",
          in: taskConfig.in || ".items",
          do: taskConfig.do || [],
        },
      };
    case "try":
      return {
        try: taskConfig.try || [],
        catch: taskConfig.catch || { errors: ["*"], do: [] },
      };
    case "raise":
      return {
        raise: {
          error: taskConfig.error || {
            status: 500,
            type: "error",
            title: "Error",
          },
        },
      };
    case "run":
      return {
        run: {
          command: taskConfig.command || "",
          args: taskConfig.args || [],
        },
      };
    default:
      // Unknown type — include raw config
      return taskConfig;
  }
}

/**
 * Sanitize a string for use as a SW 1.0 task name.
 */
function sanitizeTaskName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "task"
  );
}
