/**
 * Jotai atoms for CNCF Serverless Workflow 1.0 editor state.
 *
 * These atoms manage the visual editor state and the underlying
 * SW 1.0 workflow document. The `spec` atom holds the source of truth
 * (the SW 1.0 JSON document), while nodes/edges are derived for rendering.
 *
 * This store can replace the relevant atoms from workflow-store.ts
 * during the big-bang cutover.
 */

import type {
  Edge,
  EdgeChange,
  Node,
  NodeChange,
} from "@xyflow/react";
import { applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { atom } from "jotai";

import type { WorkflowEdge, WorkflowNode, WorkflowNodeData } from "./graph-types";
import type { Workflow, TaskType } from "./types";
import { SW_DSL_VERSION } from "./types";
import { compileGraphToWorkflow } from "./compile";
import { decompileWorkflowToGraph } from "./decompile";

// ---------------------------------------------------------------------------
// Re-export types for backwards compatibility
// ---------------------------------------------------------------------------

export type SWWorkflowNodeType = TaskType | "start" | "end";

export type SWWorkflowNodeData = WorkflowNodeData;

export type SWWorkflowNode = Node<SWWorkflowNodeData>;
export type SWWorkflowEdge = Edge;

// ---------------------------------------------------------------------------
// Core graph state atoms
// ---------------------------------------------------------------------------

/** The visual nodes in the editor */
export const swNodesAtom = atom<SWWorkflowNode[]>([]);

/** The visual edges in the editor */
export const swEdgesAtom = atom<SWWorkflowEdge[]>([]);

/** Currently selected node ID */
export const swSelectedNodeAtom = atom<string | null>(null);

/** Currently selected edge ID */
export const swSelectedEdgeAtom = atom<string | null>(null);

// ---------------------------------------------------------------------------
// Workflow document atom (source of truth)
// ---------------------------------------------------------------------------

/** The CNCF Serverless Workflow 1.0 document (source of truth) */
export const swSpecAtom = atom<Workflow | null>(null);

/** DSL version */
export const swSpecVersionAtom = atom<string>(SW_DSL_VERSION);

// ---------------------------------------------------------------------------
// Workflow metadata atoms
// ---------------------------------------------------------------------------

export const swWorkflowIdAtom = atom<string | null>(null);
export const swWorkflowNameAtom = atom<string>("");
export const swWorkflowDescriptionAtom = atom<string>("");
export const swWorkflowNamespaceAtom = atom<string>("default");
export const swWorkflowVersionAtom = atom<string>("0.0.1");

/** Whether there are unsaved changes */
export const swHasUnsavedChangesAtom = atom<boolean>(false);

// ---------------------------------------------------------------------------
// Execution state atoms
// ---------------------------------------------------------------------------

export const swSelectedExecutionIdAtom = atom<string | null>(null);
export const swCurrentRunningTaskAtom = atom<string | null>(null);

/** Task execution status by task name */
export const swTaskStatusAtom = atom<
  Record<string, "idle" | "running" | "success" | "error" | "skipped">
>({});

// ---------------------------------------------------------------------------
// Node/edge change handlers
// ---------------------------------------------------------------------------

/** Apply node changes from @xyflow/react */
export const swOnNodesChangeAtom = atom(
  null,
  (get, set, changes: NodeChange[]) => {
    const nodes = get(swNodesAtom);
    set(swNodesAtom, applyNodeChanges(changes, nodes) as SWWorkflowNode[]);
    set(swHasUnsavedChangesAtom, true);
  },
);

/** Apply edge changes from @xyflow/react */
export const swOnEdgesChangeAtom = atom(
  null,
  (get, set, changes: EdgeChange[]) => {
    const edges = get(swEdgesAtom);
    set(swEdgesAtom, applyEdgeChanges(changes, edges) as SWWorkflowEdge[]);
    set(swHasUnsavedChangesAtom, true);
  },
);

// ---------------------------------------------------------------------------
// Load / Save operations
// ---------------------------------------------------------------------------

/** Load a SW 1.0 workflow into the editor (decompile to visual graph) */
export const swLoadWorkflowAtom = atom(
  null,
  (_get, set, workflow: Workflow) => {
    const graph = decompileWorkflowToGraph(workflow);
    set(swSpecAtom, workflow);
    set(swNodesAtom, graph.nodes as SWWorkflowNode[]);
    set(swEdgesAtom, graph.edges as SWWorkflowEdge[]);
    set(swWorkflowNameAtom, workflow.document.title || workflow.document.name);
    set(swWorkflowDescriptionAtom, workflow.document.summary || "");
    set(swWorkflowNamespaceAtom, workflow.document.namespace);
    set(swWorkflowVersionAtom, workflow.document.version);
    set(swHasUnsavedChangesAtom, false);
  },
);

/** Compile the current visual graph to a SW 1.0 workflow document */
export const swCompileWorkflowAtom = atom((get) => {
  const nodes = get(swNodesAtom) as unknown as WorkflowNode[];
  const edges = get(swEdgesAtom) as unknown as WorkflowEdge[];
  const name = get(swWorkflowNameAtom);
  const namespace = get(swWorkflowNamespaceAtom);
  const version = get(swWorkflowVersionAtom);
  const description = get(swWorkflowDescriptionAtom);

  return compileGraphToWorkflow(
    { nodes, edges },
    {
      namespace,
      name,
      version,
      title: name,
      summary: description || undefined,
    },
  );
});

// ---------------------------------------------------------------------------
// Task palette (for adding new nodes)
// ---------------------------------------------------------------------------

export interface TaskPaletteItem {
  type: TaskType;
  label: string;
  description: string;
  icon: string;
  category: "control-flow" | "data" | "integration" | "error-handling";
}

export const TASK_PALETTE: TaskPaletteItem[] = [
  // Integration
  { type: "call", label: "Call", description: "HTTP, gRPC, or function call", icon: "Globe", category: "integration" },
  { type: "run", label: "Run", description: "Shell, script, container, or child workflow", icon: "Zap", category: "integration" },
  { type: "emit", label: "Emit", description: "Publish an event", icon: "Send", category: "integration" },
  { type: "listen", label: "Listen", description: "Wait for an event", icon: "Headphones", category: "integration" },

  // Control flow
  { type: "switch", label: "Switch", description: "Conditional branching", icon: "GitBranch", category: "control-flow" },
  { type: "for", label: "For", description: "Iterate over items", icon: "Repeat", category: "control-flow" },
  { type: "fork", label: "Fork", description: "Parallel execution", icon: "GitFork", category: "control-flow" },
  { type: "wait", label: "Wait", description: "Delay execution", icon: "Clock", category: "control-flow" },
  { type: "do", label: "Do", description: "Sequential sub-tasks", icon: "Layers", category: "control-flow" },

  // Data
  { type: "set", label: "Set", description: "Set variables", icon: "Variable", category: "data" },

  // Error handling
  { type: "try", label: "Try/Catch", description: "Error handling", icon: "Shield", category: "error-handling" },
  { type: "raise", label: "Raise", description: "Throw an error", icon: "OctagonAlert", category: "error-handling" },
];
