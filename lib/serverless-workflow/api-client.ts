/**
 * API client methods for CNCF Serverless Workflow 1.0 operations.
 *
 * These extend the existing api-client.ts with SW 1.0 specific endpoints.
 * The orchestrator exposes POST /api/v2/sw-workflows for executing
 * SW 1.0 workflow documents.
 */

import type { Workflow } from "./types";
import type { SWSavedWorkflow, SWWorkflowData } from "./api-types";

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiCall<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(endpoint, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new ApiError(res.status, text);
  }

  return res.json();
}

// ---------------------------------------------------------------------------
// Orchestrator URL (same pattern as existing api-client)
// ---------------------------------------------------------------------------

function getOrchestratorUrl(): string {
  return (
    process.env.WORKFLOW_ORCHESTRATOR_URL ||
    process.env.DAPR_ORCHESTRATOR_URL ||
    "http://workflow-orchestrator:8080"
  );
}

// ---------------------------------------------------------------------------
// SW 1.0 API methods
// ---------------------------------------------------------------------------

export const swApi = {
  /**
   * Execute a SW 1.0 workflow document via the orchestrator.
   * POST /api/v2/sw-workflows
   */
  execute: (
    workflow: Workflow,
    triggerData: Record<string, unknown> = {},
    options?: {
      integrations?: Record<string, Record<string, string>>;
      dbExecutionId?: string;
    },
  ) =>
    apiCall<{
      instanceId: string;
      workflowId: string;
      status: string;
      workflowVersion: string;
    }>(`${getOrchestratorUrl()}/api/v2/sw-workflows`, {
      method: "POST",
      body: JSON.stringify({
        workflow,
        triggerData,
        integrations: options?.integrations,
        dbExecutionId: options?.dbExecutionId,
      }),
    }),

  /**
   * Save a SW 1.0 workflow to the database.
   * Uses the existing workflow API with the spec field.
   */
  save: (data: SWWorkflowData) =>
    apiCall<SWSavedWorkflow>(
      data.id ? `/api/workflows/${data.id}` : "/api/workflows/create",
      {
        method: data.id ? "PUT" : "POST",
        body: JSON.stringify({
          name: data.name,
          description: data.description,
          nodes: data.nodes,
          edges: data.edges,
          spec: data.spec,
          specVersion: data.specVersion,
          visibility: data.visibility,
        }),
      },
    ),

  /**
   * Load a SW 1.0 workflow from the database.
   */
  load: (id: string) =>
    apiCall<SWSavedWorkflow>(`/api/workflows/${id}`),
};
