/**
 * API types for SW 1.0 workflow data.
 *
 * These types define how SW 1.0 workflows are stored and transmitted
 * between the frontend, API, and backend orchestrator.
 *
 * Storage model:
 *   - `spec`: The full CNCF Serverless Workflow 1.0 JSON document (source of truth)
 *   - `nodes`/`edges`: The decompiled visual graph for @xyflow/react rendering (derived)
 *   - `specVersion`: The SW DSL version ("1.0.0")
 */

import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from "./graph-types";
import type { Workflow } from "./types";

export type WorkflowVisibility = "private" | "public";

/** Workflow data as stored and exchanged via API */
export interface SWWorkflowData {
  id?: string;
  name?: string;
  description?: string;

  /** The CNCF Serverless Workflow 1.0 JSON document (source of truth) */
  spec: Workflow;
  /** DSL version: "1.0.0" */
  specVersion: string;

  /** Visual graph nodes (derived from spec via decompile) */
  nodes: WorkflowNode[];
  /** Visual graph edges (derived from spec via decompile) */
  edges: WorkflowEdge[];

  visibility?: WorkflowVisibility;
}

/** Saved workflow with server-generated fields */
export interface SWSavedWorkflow extends SWWorkflowData {
  id: string;
  name: string;
  visibility: WorkflowVisibility;
  createdAt: string;
  updatedAt: string;
  isOwner?: boolean;
  publishedRuntime?: SWPublishedRuntimeMetadata | null;
}

/** Published revision metadata */
export interface SWPublishedRevision {
  version: string;
  publishedAt: string;
  /** The frozen SW 1.0 document at time of publish */
  definition: Workflow;
}

/** Published runtime metadata */
export interface SWPublishedRuntimeMetadata {
  status: "published";
  workflowName: string;
  latestVersion: string;
  publishedAt: string;
  revisions: SWPublishedRevision[];
}
