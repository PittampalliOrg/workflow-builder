/**
 * Executes AI operations against the workflow store.
 * Resolves $new_N references, looks up catalog actions for call nodes,
 * and handles linear insertion and branching.
 */

import type {
  createWorkflowStore,
  WorkflowNodeType,
} from "$lib/stores/workflow.svelte";
import { normalizeAgentTaskConfig } from "$lib/types/agent-graph";

// Legacy operation type (deprecated — use ai-spec-applier.ts instead)
type AiOperation =
  | {
      op: "add_node";
      type: string;
      label: string;
      after?: string;
      position?: { x: number; y: number };
      taskConfig?: Record<string, unknown>;
    }
  | {
      op: "update_node";
      nodeId: string;
      label?: string;
      taskConfig?: Record<string, unknown>;
      description?: string;
    }
  | { op: "remove_node"; nodeId: string }
  | { op: "add_edge"; source: string; target: string; sourceHandle?: string }
  | { op: "remove_edge"; edgeId?: string; source?: string; target?: string }
  | { op: "set_workflow_name"; name: string };

type WorkflowStore = ReturnType<typeof createWorkflowStore>;

const VALID_NODE_TYPES = new Set<string>([
  "start",
  "end",
  "call",
  "agent",
  "set",
  "switch",
  "wait",
  "emit",
  "listen",
  "for",
  "fork",
  "try",
  "run",
  "raise",
  "do",
]);

/**
 * Look up a catalog action by function name and apply full metadata to a node.
 * This wires the node to the ActivePieces provider system (icon, config UI, connection dropdown).
 */
async function applyCallActionFromCatalog(
  store: WorkflowStore,
  nodeId: string,
  functionName: string,
  llmArguments?: Record<string, unknown>,
): Promise<boolean> {
  try {
    // First find the action in the catalog snapshot
    const catalogRes = await fetch("/api/action-catalog");
    if (!catalogRes.ok) return false;
    const snapshot = await catalogRes.json();
    const items = snapshot.items as Array<Record<string, unknown>>;

    // Match by exact name first, then fuzzy match by provider + keywords
    let match = items.find(
      (i) =>
        i.name === functionName ||
        i.actionName === functionName ||
        i.id === functionName,
    );

    if (!match) {
      // Fuzzy match: extract provider prefix and keywords from the function name
      // e.g. "discord-send_channel_message" → provider="discord", keywords=["send","channel","message"]
      const parts = functionName.split(/[-_]/);
      const provider = parts[0]?.toLowerCase();
      const keywords = parts.slice(1).map((p: string) => p.toLowerCase());

      if (provider && keywords.length > 0) {
        // Find items from the same provider, score by keyword overlap
        const candidates = items.filter(
          (i) =>
            ((i.providerId as string) || "").toLowerCase() === provider &&
            i.insertable,
        );
        let bestScore = 0;
        for (const candidate of candidates) {
          const candidateParts = ((candidate.name as string) || "")
            .toLowerCase()
            .split(/[-_]/);
          const score = keywords.filter((kw: string) =>
            candidateParts.some(
              (cp: string) => cp.includes(kw) || kw.includes(cp),
            ),
          ).length;
          if (score > bestScore) {
            bestScore = score;
            match = candidate;
          }
        }
      }
    }

    if (!match) return false;

    // Fetch full detail for this action
    const detailRes = await fetch(
      `/api/action-catalog/${encodeURIComponent(match.id as string)}`,
    );
    if (!detailRes.ok) return false;
    const detail = await detailRes.json();

    // Apply full metadata — mirrors command-palette.svelte applyActionToNode()
    const actionDefinition = {
      id: match.id,
      name: match.name,
      displayName: match.displayName,
      service: match.service,
      kind: match.kind,
      visibility: match.visibility,
      sourceKind: match.sourceKind,
      version: match.version,
      language: match.language,
      entrypoint: match.entrypoint,
      insertable: match.insertable,
    };

    let taskConfig = (detail.taskConfig || detail.definition || {}) as Record<
      string,
      unknown
    >;

    // Merge LLM-provided arguments into the AP taskConfig.with.body.input
    if (
      llmArguments &&
      Object.keys(llmArguments).length > 0 &&
      taskConfig.with
    ) {
      const withBlock = taskConfig.with as Record<string, unknown>;
      const body = (withBlock.body || {}) as Record<string, unknown>;
      const existingInput = (body.input || {}) as Record<string, unknown>;

      // Map common LLM field names to AP field names
      const fieldMapping: Record<string, string> = {
        to: "receiver",
        recipients: "receiver",
      };
      const mappedArgs: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(llmArguments)) {
        const mappedKey = fieldMapping[key] || key;
        if (
          ["receiver", "cc", "bcc", "reply_to", "attachments"].includes(
            mappedKey,
          ) &&
          !Array.isArray(value)
        ) {
          mappedArgs[mappedKey] = [value];
        } else {
          mappedArgs[mappedKey] = value;
        }
      }

      taskConfig = {
        ...taskConfig,
        with: {
          ...withBlock,
          body: { ...body, input: { ...existingInput, ...mappedArgs } },
        },
      };
    }

    // Apply metadata directly to the node (skip pushHistory to avoid DataCloneError)
    const catalogMeta = {
      label: match.displayName as string,
      taskConfig,
      actionDefinition,
      catalogFunction:
        match.service === "fn-activepieces"
          ? {
              name: match.name as string,
              displayName: match.displayName as string,
              pieceName: (match.providerId || match.pieceName) as string,
              actionName: match.actionName as string,
            }
          : undefined,
      actionCatalogDetail: detail,
    };

    // Update node without triggering history (structuredClone would fail on catalog detail)
    store.nodes = store.nodes.map((n) =>
      n.id === nodeId ? { ...n, data: { ...n.data, ...catalogMeta } } : n,
    );

    // Update the spec task with the catalog's SW definition (for orchestrator execution)
    if (store.spec) {
      const taskName = resolveNodeIdToTaskName(nodeId, store);
      if (taskName) {
        const doArray = ((store.spec as Record<string, unknown>).do ||
          []) as Array<Record<string, unknown>>;
        const taskEntry = doArray.find((e) => Object.keys(e)[0] === taskName);
        if (taskEntry) {
          // Use sw.definition which has the proper HTTP call to fn-activepieces
          const swDef = (detail.definition || detail.sw?.definition) as
            | Record<string, unknown>
            | undefined;
          if (swDef) {
            // Merge LLM-provided field values into the definition's body.input
            const defWithBlock = (swDef.with || {}) as Record<string, unknown>;
            const defBody = (defWithBlock.body || {}) as Record<
              string,
              unknown
            >;
            const existingInput = taskConfig?.with
              ? (
                  (taskConfig.with as Record<string, unknown>).body as Record<
                    string,
                    unknown
                  >
                )?.input || {}
              : {};
            taskEntry[taskName] = {
              ...swDef,
              with: {
                ...defWithBlock,
                body: {
                  ...defBody,
                  input: existingInput,
                },
              },
            };
          } else {
            taskEntry[taskName] = taskConfig;
          }
          store.spec = { ...store.spec, do: [...doArray] };
        }
      }
    }

    return true;
  } catch (err) {
    console.error("[applyCallAction] Failed:", err);
    return false;
  }
}

/**
 * Execute a batch of AI operations against the workflow store.
 * Returns the number of operations applied and any errors.
 */
export async function executeOperations(
  store: WorkflowStore,
  operations: AiOperation[],
): Promise<{ applied: number; errors: string[] }> {
  const errors: string[] = [];
  let applied = 0;

  const newNodeIds = new Map<string, string>();
  let addNodeIndex = 0;

  // Collect call nodes that need catalog lookup (async after all ops)
  const callNodesToLookup: {
    nodeId: string;
    functionName: string;
    arguments?: Record<string, unknown>;
  }[] = [];

  for (const op of operations) {
    try {
      switch (op.op) {
        case "add_node": {
          const nodeType = op.type as WorkflowNodeType;
          if (!VALID_NODE_TYPES.has(nodeType)) {
            errors.push(`Invalid node type: ${op.type}`);
            break;
          }

          // Build the SW 1.0 task definition from the operation
          const taskName = sanitizeTaskName(op.label);
          const taskDef = buildTaskDef(nodeType, op.taskConfig || {});

          // Resolve "after" to a task name for insertion
          const afterId = op.after
            ? resolveRef(op.after, newNodeIds, store)
            : null;
          const afterTaskName = afterId
            ? resolveNodeIdToTaskName(afterId, store)
            : undefined;

          // Use spec-first: add task to spec.do[] and rebuild graph (await the async rebuild)
          const resultName = await store.addTask(
            taskName,
            taskDef,
            afterTaskName,
          );

          // If this is a call node with a function reference, queue catalog lookup
          if (resultName && nodeType === "call" && op.taskConfig?.function) {
            // Queue catalog lookup — node ID will be resolved after graph rebuild
            callNodesToLookup.push({
              nodeId: taskName, // Will be resolved to actual node ID later
              functionName: op.taskConfig.function as string,
              arguments: op.taskConfig.arguments as
                | Record<string, unknown>
                | undefined,
            });
          }

          newNodeIds.set(`$new_${addNodeIndex}`, taskName);
          addNodeIndex++;
          applied++;
          break;
        }

        case "update_node": {
          const nodeId = resolveRef(op.nodeId, newNodeIds, store);
          const existingNode = store.nodes.find((n) => n.id === nodeId);
          if (!existingNode) {
            errors.push(`Node not found: ${op.nodeId}`);
            break;
          }

          // In spec-first mode, also update the spec task
          if (store.spec && op.taskConfig) {
            const taskName = resolveNodeIdToTaskName(nodeId, store);
            if (taskName) {
              const newConfig = op.taskConfig as Record<string, unknown>;
              // Merge arguments into the spec task's with block
              if (newConfig.arguments) {
                const doArray = ((store.spec as Record<string, unknown>).do ||
                  []) as Array<Record<string, unknown>>;
                const taskEntry = doArray.find(
                  (e) => Object.keys(e)[0] === taskName,
                );
                if (taskEntry) {
                  const existingTask = taskEntry[taskName] as Record<
                    string,
                    unknown
                  >;
                  const existingWith = (existingTask.with || {}) as Record<
                    string,
                    unknown
                  >;
                  taskEntry[taskName] = {
                    ...existingTask,
                    with: {
                      ...existingWith,
                      ...(newConfig.arguments as Record<string, unknown>),
                    },
                  };
                  store.spec = { ...store.spec, do: [...doArray] };
                }
              }
            }
          }
          const updates: Record<string, unknown> = {};
          if (op.label !== undefined) updates.label = op.label;
          if (op.description !== undefined)
            updates.description = op.description;
          if (op.taskConfig !== undefined) {
            const existingConfig = (
              existingNode.data as Record<string, unknown>
            )?.taskConfig as Record<string, unknown> | undefined;
            const newConfig = op.taskConfig as Record<string, unknown>;

            // If the existing node has AP task config (with.body.input) and the LLM sends arguments,
            // merge the arguments into the AP input structure instead of replacing
            if (existingConfig?.with && newConfig.arguments) {
              const withBlock = existingConfig.with as Record<string, unknown>;
              const body = (withBlock.body || {}) as Record<string, unknown>;
              const existingInput = (body.input || {}) as Record<
                string,
                unknown
              >;
              const args = newConfig.arguments as Record<string, unknown>;

              // Map common LLM field names to AP field names
              const fieldMapping: Record<string, string> = {
                to: "receiver",
                recipients: "receiver",
              };
              const mappedArgs: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(args)) {
                const mappedKey = fieldMapping[key] || key;
                // AP expects receiver/cc/bcc as arrays
                if (
                  ["receiver", "cc", "bcc", "reply_to", "attachments"].includes(
                    mappedKey,
                  ) &&
                  !Array.isArray(value)
                ) {
                  mappedArgs[mappedKey] = [value];
                } else {
                  mappedArgs[mappedKey] = value;
                }
              }

              updates.taskConfig = {
                ...existingConfig,
                with: {
                  ...withBlock,
                  body: {
                    ...body,
                    input: { ...existingInput, ...mappedArgs },
                  },
                },
              };
            } else {
              // No AP structure — just replace taskConfig directly
              updates.taskConfig = newConfig;
            }
          }
          if (Object.keys(updates).length > 0) {
            store.updateNodeData(nodeId, updates);
          }
          applied++;
          break;
        }

        case "remove_node": {
          const nodeId = resolveRef(op.nodeId, newNodeIds, store);
          // In spec-first mode, remove from spec
          if (store.spec) {
            const taskName = resolveNodeIdToTaskName(nodeId, store);
            if (taskName) {
              store.removeTask(taskName);
              applied++;
            } else {
              errors.push(`Task not found for node: ${op.nodeId}`);
            }
          } else {
            if (!store.nodes.find((n) => n.id === nodeId)) {
              errors.push(`Node not found: ${op.nodeId}`);
              break;
            }
            store.removeNode(nodeId);
            applied++;
          }
          break;
        }

        case "add_edge": {
          // In spec-first mode, edges are derived from spec — skip
          if (store.spec) {
            applied++; // Count as applied (no-op, edges are auto-derived)
            break;
          }
          const source = resolveRef(op.source, newNodeIds, store);
          const target = resolveRef(op.target, newNodeIds, store);
          store.addEdge(source, target, op.sourceHandle);
          applied++;
          break;
        }

        case "remove_edge": {
          // In spec-first mode, edges are derived from spec — skip
          if (store.spec) {
            applied++;
            break;
          }
          if (op.edgeId) {
            store.removeEdge(op.edgeId);
          } else if (op.source && op.target) {
            const source = resolveRef(op.source, newNodeIds, store);
            const target = resolveRef(op.target, newNodeIds, store);
            const edge = store.edges.find(
              (e) => e.source === source && e.target === target,
            );
            if (edge) {
              store.removeEdge(edge.id);
            } else {
              errors.push(`Edge not found: ${op.source} → ${op.target}`);
            }
          }
          applied++;
          break;
        }

        case "set_workflow_name": {
          store.workflowName = op.name;
          applied++;
          break;
        }

        default:
          errors.push(`Unknown operation: ${(op as { op: string }).op}`);
      }
    } catch (err) {
      errors.push(
        `${op.op} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Resolve catalog actions for call nodes (graph already rebuilt from spec)
  if (callNodesToLookup.length > 0) {
    await Promise.all(
      callNodesToLookup.map(
        async ({ nodeId: taskNameOrId, functionName, arguments: args }) => {
          const matchNode = store.nodes.find(
            (n) =>
              n.id.includes(taskNameOrId) ||
              (n.data as Record<string, unknown>)?.label === taskNameOrId,
          );
          const actualNodeId = matchNode?.id || taskNameOrId;

          const resolved = await applyCallActionFromCatalog(
            store,
            actualNodeId,
            functionName,
            args,
          );
          if (resolved) {
            // Cache metadata by task name so it survives graph rebuilds
            const taskName = resolveNodeIdToTaskName(actualNodeId, store);
            if (taskName) {
              const node = store.nodes.find((n) => n.id === actualNodeId);
              const nodeData = node?.data as
                | Record<string, unknown>
                | undefined;
              if (nodeData?.actionCatalogDetail) {
                store.setTaskMetadata(taskName, {
                  actionDefinition: nodeData.actionDefinition,
                  catalogFunction: nodeData.catalogFunction,
                  actionCatalogDetail: nodeData.actionCatalogDetail,
                });
              }
            }
          } else {
            errors.push(`Could not resolve catalog action: ${functionName}`);
          }
        },
      ),
    );
  }

  return { applied, errors };
}

function resolveRef(
  ref: string,
  newNodeIds: Map<string, string>,
  store: WorkflowStore,
): string {
  if (ref.startsWith("$new_")) {
    return newNodeIds.get(ref) || ref;
  }
  if (store.nodes.find((n) => n.id === ref)) {
    return ref;
  }
  const partial = store.nodes.find(
    (n) => n.id.startsWith(ref) || n.id.includes(ref),
  );
  if (partial) {
    return partial.id;
  }
  return ref;
}

function calculateInsertPosition(
  store: WorkflowStore,
  afterNodeId: string,
): { x: number; y: number } {
  const node = store.nodes.find((n) => n.id === afterNodeId);
  if (node) {
    return { x: node.position.x, y: node.position.y + 150 };
  }
  return calculateDefaultPosition(store);
}

function calculateDefaultPosition(store: WorkflowStore): {
  x: number;
  y: number;
} {
  const nodes = store.nodes;
  if (nodes.length > 0) {
    const maxY = Math.max(...nodes.map((n) => n.position.y));
    const avgX = nodes.reduce((sum, n) => sum + n.position.x, 0) / nodes.length;
    return { x: avgX, y: maxY + 150 };
  }
  return { x: 250, y: 100 };
}

/**
 * Build a SW 1.0 task definition from a node type and taskConfig.
 */
function buildTaskDef(
  nodeType: string,
  taskConfig: Record<string, unknown>,
): Record<string, unknown> {
  // If taskConfig already has the SW 1.0 structure (call/with), use as-is
  if (
    taskConfig.call ||
    taskConfig.set ||
    taskConfig.switch ||
    taskConfig.wait ||
    taskConfig.emit ||
    taskConfig.listen ||
    taskConfig.for ||
    taskConfig.fork ||
    taskConfig.try ||
    taskConfig.run ||
    taskConfig.raise
  ) {
    return taskConfig;
  }

  switch (nodeType) {
    case "call": {
      const fn = taskConfig.function as string | undefined;
      return {
        call: fn || "http",
        with: taskConfig.arguments || {},
      };
    }
    case "agent":
      return normalizeAgentTaskConfig(taskConfig);
    case "set":
      return { set: taskConfig.variables || taskConfig };
    case "switch":
      return { switch: taskConfig.conditions || [] };
    case "wait":
      return { wait: taskConfig.duration || "PT0S" };
    case "emit":
      return { emit: { event: taskConfig.event || {} } };
    case "listen":
      return { listen: { to: taskConfig.event || {} } };
    case "for":
      return {
        for: { each: taskConfig.each || "item", in: taskConfig.in || ".items" },
        do: taskConfig.do || [],
      };
    case "try":
      return {
        try: taskConfig.try || [],
        catch: taskConfig.catch || { errors: ["*"], do: [] },
      };
    case "run":
      return { run: { command: taskConfig.command || "" } };
    case "raise":
      return {
        raise: { error: taskConfig.error || { type: "error", title: "Error" } },
      };
    default:
      return taskConfig;
  }
}

/**
 * Sanitize a label for use as a SW 1.0 task name.
 */
function sanitizeTaskName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "task"
  );
}

/**
 * Resolve a node ID (which may be a SvelteFlow path like "/do/0/task-name") to a task name.
 */
function resolveNodeIdToTaskName(
  nodeId: string,
  store: WorkflowStore,
): string | undefined {
  // If it's a spec path like "/do/0/task-name", extract the task name
  const parts = nodeId.split("/");
  if (parts.length >= 3) {
    return parts[parts.length - 1];
  }
  // If it's __start__ or __end__, return undefined (can't insert after these in spec)
  if (nodeId === "__start__" || nodeId === "__end__") {
    return undefined; // Will append to end of do array
  }
  // Otherwise, it might already be a task name
  return nodeId;
}
