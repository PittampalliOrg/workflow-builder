/**
 * Dapr Orchestrator API Client
 *
 * Proxy client that talks to the Dapr orchestrator's FastAPI endpoints.
 * The orchestratorUrl is stored per-workflow in the DB or configured via
 * DAPR_ORCHESTRATOR_URL environment variable.
 *
 * Contract aligned with planner-orchestrator/app.py (Pydantic models).
 */

/**
 * Response from GET /api/workflows/{id}/status
 * Matches WorkflowStatusResponse in the orchestrator.
 */
export type DaprWorkflowStatus = {
  workflow_id: string;
  runtime_status: string; // "RUNNING" | "COMPLETED" | "FAILED" | "TERMINATED" | "PENDING" | "SUSPENDED" | "UNKNOWN"
  phase?: string | null; // "planning" | "persisting" | "awaiting_approval" | "executing" | "completed" | "failed" | "rejected" | "timed_out"
  progress?: number | null; // 0-100
  message?: string | null;
  output?: Record<string, unknown> | null; // Final workflow output (tasks and metadata)
};

/**
 * Task object returned from Dapr statestore.
 */
export type DaprWorkflowTask = {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  created_at?: string;
};

/**
 * Response from GET /api/workflows/{id}/tasks
 * The orchestrator wraps tasks in { workflow_id, tasks, count }.
 */
export type DaprWorkflowTasksResponse = {
  workflow_id: string;
  tasks: DaprWorkflowTask[];
  count: number;
};

/**
 * Response from POST /api/workflows
 * Matches WorkflowStartResponse in the orchestrator.
 */
export type DaprStartWorkflowResult = {
  workflow_id: string;
  status: string; // "started"
};

/**
 * Response from POST /api/workflows/{id}/approve
 */
export type DaprApproveResult = {
  status: string; // "event_raised"
  workflow_id: string;
};

async function daprFetch<T>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Dapr orchestrator error (${response.status}): ${errorBody}`
    );
  }

  return response.json();
}

export const daprClient = {
  /**
   * Start a new Dapr workflow instance.
   * Maps to: POST {orchestratorUrl}/api/workflows
   *
   * The orchestrator expects { feature_request, cwd } and returns { workflow_id, status }.
   */
  startWorkflow: (
    orchestratorUrl: string,
    featureRequest: string,
    cwd: string = ""
  ): Promise<DaprStartWorkflowResult> =>
    daprFetch(`${orchestratorUrl}/api/workflows`, {
      method: "POST",
      body: JSON.stringify({
        feature_request: featureRequest,
        cwd,
      }),
    }),

  /**
   * Get the status of a Dapr workflow instance.
   * Maps to: GET {orchestratorUrl}/api/workflows/{id}/status
   *
   * Returns flat structure: { workflow_id, runtime_status, phase, progress, message, output }.
   */
  getWorkflowStatus: (
    orchestratorUrl: string,
    workflowId: string
  ): Promise<DaprWorkflowStatus> =>
    daprFetch(`${orchestratorUrl}/api/workflows/${workflowId}/status`),

  /**
   * Get tasks produced by a Dapr workflow from the statestore.
   * Maps to: GET {orchestratorUrl}/api/workflows/{id}/tasks
   *
   * Returns { workflow_id, tasks, count } — the caller should unwrap .tasks.
   */
  getWorkflowTasks: (
    orchestratorUrl: string,
    workflowId: string
  ): Promise<DaprWorkflowTasksResponse> =>
    daprFetch(`${orchestratorUrl}/api/workflows/${workflowId}/tasks`),

  /**
   * Approve or reject a Dapr workflow that is awaiting approval.
   * Maps to: POST {orchestratorUrl}/api/workflows/{id}/approve
   *
   * Raises the plan_approval_{workflow_id} external event in the Dapr workflow.
   */
  approveWorkflow: (
    orchestratorUrl: string,
    workflowId: string,
    approved: boolean,
    reason?: string
  ): Promise<DaprApproveResult> =>
    daprFetch(`${orchestratorUrl}/api/workflows/${workflowId}/approve`, {
      method: "POST",
      body: JSON.stringify({ approved, reason: reason || "" }),
    }),
};
