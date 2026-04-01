/**
 * CNCF Serverless Workflow 1.0 integration for workflow-builder.
 *
 * Replaces the custom workflow-spec/v1 DSL with the open standard.
 */

// Core SW 1.0 types
export * from "./types";

// Visual graph types (bridge between SW 1.0 and @xyflow/react)
export * from "./graph-types";

// Compile: visual graph -> SW 1.0 JSON
export { compileGraphToWorkflow } from "./compile";
export type { CompileOptions } from "./compile";

// Decompile: SW 1.0 JSON -> visual graph
export { decompileWorkflowToGraph } from "./decompile";

// Function catalog: Dapr service action definitions
export {
  buildUseFunctions,
  FUNCTION_CATALOG,
  getCatalogByCategory,
  getCatalogFunction,
} from "./function-catalog";
export type { CatalogFunction } from "./function-catalog";

// API types
export type {
  SWPublishedRevision,
  SWPublishedRuntimeMetadata,
  SWSavedWorkflow,
  SWWorkflowData,
  WorkflowVisibility,
} from "./api-types";

// Store (Jotai atoms)
export {
  swNodesAtom,
  swEdgesAtom,
  swSelectedNodeAtom,
  swSelectedEdgeAtom,
  swSpecAtom,
  swSpecVersionAtom,
  swWorkflowIdAtom,
  swWorkflowNameAtom,
  swWorkflowDescriptionAtom,
  swWorkflowNamespaceAtom,
  swWorkflowVersionAtom,
  swHasUnsavedChangesAtom,
  swSelectedExecutionIdAtom,
  swCurrentRunningTaskAtom,
  swTaskStatusAtom,
  swOnNodesChangeAtom,
  swOnEdgesChangeAtom,
  swLoadWorkflowAtom,
  swCompileWorkflowAtom,
  TASK_PALETTE,
} from "./store";
export type {
  SWWorkflowNode,
  SWWorkflowEdge,
  SWWorkflowNodeData,
  SWWorkflowNodeType,
  TaskPaletteItem,
} from "./store";

// API client
export { swApi } from "./api-client";

// Layout
export { layoutDagPositions } from "./layout";
