/**
 * Decompile: CNCF Serverless Workflow 1.0 JSON -> Visual graph (nodes + edges)
 *
 * Walks the workflow's `do` task list and produces @xyflow/react compatible
 * nodes and edges for the visual editor.
 */

import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "./graph-types";
import { layoutDagPositions } from "./layout";
import type {
  DoTask,
  FlowDirective,
  ForTask,
  ForkTask,
  SwitchCase,
  SwitchTask,
  Task,
  TaskItem,
  TryTask,
  Workflow,
} from "./types";
import { getTaskType, unwrapTaskItem } from "./types";

// ---------------------------------------------------------------------------
// Task -> label helpers
// ---------------------------------------------------------------------------

function taskLabel(name: string, task: Task): string {
  const type = getTaskType(task);
  switch (type) {
    case "call": {
      const callTask = task as { call: string };
      return `${name} (${callTask.call})`;
    }
    case "run": {
      const runTask = task as unknown as { run: Record<string, unknown> };
      const runType = Object.keys(runTask.run)[0] || "run";
      return `${name} (${runType})`;
    }
    default:
      return name;
  }
}

// ---------------------------------------------------------------------------
// Core decompiler
// ---------------------------------------------------------------------------

interface DecompileContext {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  idCounter: number;
}

function addEdge(
  ctx: DecompileContext,
  source: string,
  target: string,
  label?: string,
  sourceHandle?: string,
) {
  ctx.edges.push({
    id: `${source}->${target}${sourceHandle ? `:${sourceHandle}` : ""}`,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
    label,
    type: "animated",
  });
}

function addNode(
  ctx: DecompileContext,
  node: WorkflowNode,
) {
  ctx.nodes.push(node);
}

/**
 * Walk a TaskItem[] (the `do` array) and produce flat nodes + edges.
 * Tasks are connected sequentially unless `then` directives override flow.
 *
 * Returns the ID of the first node and the IDs of terminal nodes (for connecting to parent).
 */
function decompileTaskList(
  ctx: DecompileContext,
  tasks: TaskItem[],
  parentPrefix: string,
): { firstId: string | null; terminalIds: string[] } {
  if (tasks.length === 0) return { firstId: null, terminalIds: [] };

  const taskEntries = tasks.map((item) => {
    const [name, task] = unwrapTaskItem(item);
    return { name, task, id: `${parentPrefix}/${name}` };
  });

  // Create nodes for each task
  for (const entry of taskEntries) {
    const type = getTaskType(entry.task);
    addNode(ctx, {
      id: entry.id,
      type,
      position: { x: 0, y: 0 }, // laid out later
      data: {
        label: taskLabel(entry.name, entry.task),
        description: entry.task.metadata?.description as string | undefined,
        taskType: type,
        taskConfig: { ...entry.task } as Record<string, unknown>,
        status: "idle",
        enabled: entry.task.if !== "false",
      },
    });

    // Handle nested task structures (do, for, fork, try)
    decompileNestedTasks(ctx, entry.id, entry.task);
  }

  // Build name->id lookup for `then` directive resolution
  const nameToId = new Map(taskEntries.map((e) => [e.name, e.id]));

  // Connect tasks sequentially, respecting `then` directives
  const terminalIds: string[] = [];

  for (let i = 0; i < taskEntries.length; i++) {
    const entry = taskEntries[i];
    const nextEntry = taskEntries[i + 1];
    const task = entry.task;

    // Handle switch tasks specially (multiple outgoing edges)
    if (getTaskType(task) === "switch") {
      const switchTask = task as SwitchTask;
      decompileSwitchEdges(ctx, entry.id, switchTask, nameToId);
      // Switch tasks are always terminal (flow is explicit)
      continue;
    }

    // Handle `then` directive
    const thenDirective = task.then;
    if (thenDirective === "end" || thenDirective === "exit") {
      terminalIds.push(entry.id);
      continue;
    }

    if (thenDirective && thenDirective !== "continue") {
      // Named task reference
      const targetId = nameToId.get(thenDirective);
      if (targetId) {
        addEdge(ctx, entry.id, targetId);
      } else {
        terminalIds.push(entry.id);
      }
      continue;
    }

    // Default: connect to next task in sequence
    if (nextEntry) {
      addEdge(ctx, entry.id, nextEntry.id);
    } else {
      terminalIds.push(entry.id);
    }
  }

  return {
    firstId: taskEntries[0]?.id ?? null,
    terminalIds,
  };
}

function decompileSwitchEdges(
  ctx: DecompileContext,
  nodeId: string,
  task: SwitchTask,
  nameToId: Map<string, string>,
) {
  for (const switchCase of task.switch) {
    for (const [caseName, caseDef] of Object.entries(switchCase)) {
      const then = caseDef.then;
      if (then && then !== "end" && then !== "exit" && then !== "continue") {
        const targetId = nameToId.get(then);
        if (targetId) {
          addEdge(ctx, nodeId, targetId, caseName, caseName);
        }
      }
    }
  }
}

function decompileNestedTasks(
  ctx: DecompileContext,
  parentId: string,
  task: Task,
) {
  const type = getTaskType(task);

  if (type === "do") {
    const doTask = task as DoTask;
    if (doTask.do && doTask.do.length > 0) {
      const result = decompileTaskList(ctx, doTask.do, parentId);
      if (result.firstId) {
        addEdge(ctx, parentId, result.firstId, "do");
      }
    }
  }

  if (type === "for") {
    const forTask = task as ForTask;
    if (forTask.do && forTask.do.length > 0) {
      const result = decompileTaskList(ctx, forTask.do, parentId);
      if (result.firstId) {
        addEdge(ctx, parentId, result.firstId, "loop");
      }
      // Loop back edges from terminal to parent
      for (const tid of result.terminalIds) {
        addEdge(ctx, tid, parentId, "next iteration");
      }
    }
  }

  if (type === "fork") {
    const forkTask = task as ForkTask;
    if (forkTask.fork?.branches) {
      for (let i = 0; i < forkTask.fork.branches.length; i++) {
        const branch = forkTask.fork.branches[i];
        const [branchName, branchTask] = unwrapTaskItem(branch);
        const branchId = `${parentId}/branch-${branchName}`;
        const branchType = getTaskType(branchTask);
        addNode(ctx, {
          id: branchId,
          type: branchType,
          position: { x: 0, y: 0 },
          data: {
            label: branchName,
            taskType: branchType,
            taskConfig: { ...branchTask } as Record<string, unknown>,
            status: "idle",
          },
        });
        addEdge(ctx, parentId, branchId, `branch ${i + 1}`);
        decompileNestedTasks(ctx, branchId, branchTask);
      }
    }
  }

  if (type === "try") {
    const tryTask = task as TryTask;
    if (tryTask.try && tryTask.try.length > 0) {
      const result = decompileTaskList(ctx, tryTask.try, `${parentId}/try`);
      if (result.firstId) {
        addEdge(ctx, parentId, result.firstId, "try");
      }
    }
    if (tryTask.catch?.do && tryTask.catch.do.length > 0) {
      const result = decompileTaskList(
        ctx,
        tryTask.catch.do,
        `${parentId}/catch`,
      );
      if (result.firstId) {
        addEdge(ctx, parentId, result.firstId, "catch");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function decompileWorkflowToGraph(workflow: Workflow): WorkflowGraph {
  const ctx: DecompileContext = {
    nodes: [],
    edges: [],
    idCounter: 0,
  };

  // Add start node
  const startId = "__start__";
  addNode(ctx, {
    id: startId,
    type: "start",
    position: { x: 0, y: 0 },
    data: {
      label: workflow.document.title || workflow.document.name,
      description: workflow.document.summary,
      taskType: "start",
      taskConfig: {
        document: workflow.document,
        input: workflow.input,
        use: workflow.use,
      },
      status: "idle",
    },
  });

  // Decompile the main task list
  const result = decompileTaskList(ctx, workflow.do, "");

  // Connect start to first task
  if (result.firstId) {
    addEdge(ctx, startId, result.firstId);
  }

  // Add end node and connect terminal tasks
  const endId = "__end__";
  addNode(ctx, {
    id: endId,
    type: "end",
    position: { x: 0, y: 0 },
    data: {
      label: "End",
      taskType: "end",
      taskConfig: { output: workflow.output },
      status: "idle",
    },
  });

  for (const tid of result.terminalIds) {
    addEdge(ctx, tid, endId);
  }

  // Apply layout
  const positions = layoutDagPositions({
    nodes: ctx.nodes.map((n) => ({ id: n.id, kind: n.type })),
    edges: ctx.edges.map((e) => ({
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
    })),
    startId,
  });

  for (const node of ctx.nodes) {
    node.position = positions[node.id] || { x: 0, y: 0 };
  }

  return { nodes: ctx.nodes, edges: ctx.edges };
}
