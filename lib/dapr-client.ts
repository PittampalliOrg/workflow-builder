/**
 * Dapr Orchestrator API Client
 *
 * Proxy client that talks to the Dapr orchestrator's FastAPI endpoints.
 * The orchestratorUrl is stored per-workflow in the DB or configured via
 * DAPR_ORCHESTRATOR_URL environment variable.
 *
 * Supports two orchestrator types:
 * 1. Python planner-dapr-agent (feature_request + cwd input)
 * 2. Generic TypeScript orchestrator (WorkflowDefinition + triggerData input)
 *
 * Contract aligned with planner-dapr-agent/app.py (Pydantic models)
 * and the workflow-orchestrator service.
 */

import type { WorkflowDefinition } from "./workflow-definition";

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

async function daprFetch<T>(url: string, options?: RequestInit): Promise<T> {
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
			`Dapr orchestrator error (${response.status}): ${errorBody}`,
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
		cwd = "",
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
		workflowId: string,
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
		workflowId: string,
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
		reason?: string,
	): Promise<DaprApproveResult> =>
		daprFetch(`${orchestratorUrl}/api/workflows/${workflowId}/approve`, {
			method: "POST",
			body: JSON.stringify({ approved, reason: reason || "" }),
		}),
};

// ─── Generic TypeScript Orchestrator Client ────────────────────────────────────

/**
 * Response from POST /api/v2/workflows (generic orchestrator)
 */
export type GenericStartWorkflowResult = {
	instanceId: string;
	workflowId: string;
	status: string; // "started"
};

/**
 * Response from GET /api/v2/workflows/{id}/status (generic orchestrator)
 */
export type GenericWorkflowStatus = {
	instanceId: string;
	workflowId: string;
	runtimeStatus: string; // "RUNNING" | "COMPLETED" | "FAILED" | "TERMINATED" | "PENDING"
	traceId?: string;
	phase: string; // "pending" | "running" | "awaiting_approval" | "completed" | "failed"
	progress: number; // 0-100
	message?: string;
	currentNodeId?: string;
	currentNodeName?: string;
	approvalEventName?: string;
	outputs?: Record<string, unknown>;
	error?: string;
	startedAt?: string;
	completedAt?: string;
};

/**
 * Response from POST /api/v2/workflows/{id}/events (generic orchestrator)
 */
export type GenericRaiseEventResult = {
	success: boolean;
	instanceId: string;
	eventName: string;
};

/**
 * Generic orchestrator client for the TypeScript workflow-orchestrator service
 */
export const genericOrchestratorClient = {
	/**
	 * Start a new generic workflow instance.
	 * Maps to: POST {orchestratorUrl}/api/v2/workflows
	 *
	 * @param orchestratorUrl - Base URL of the orchestrator service
	 * @param definition - The workflow definition to execute
	 * @param triggerData - Input data that triggered the workflow
	 * @param integrations - Optional map of integration credentials
	 * @param dbExecutionId - Database execution ID for logging (links to workflow_executions.id)
	 */
	startWorkflow: (
		orchestratorUrl: string,
		definition: WorkflowDefinition,
		triggerData: Record<string, unknown>,
		integrations?: Record<string, Record<string, string>>,
		dbExecutionId?: string,
		nodeConnectionMap?: Record<string, string>,
	): Promise<GenericStartWorkflowResult> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows`, {
			method: "POST",
			body: JSON.stringify({
				definition,
				triggerData,
				integrations,
				dbExecutionId,
				nodeConnectionMap,
			}),
		}),

	/**
	 * Get the status of a generic workflow instance.
	 * Maps to: GET {orchestratorUrl}/api/v2/workflows/{id}/status
	 */
	getWorkflowStatus: (
		orchestratorUrl: string,
		instanceId: string,
	): Promise<GenericWorkflowStatus> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}/status`),

	/**
	 * Raise an external event to a running workflow.
	 * Maps to: POST {orchestratorUrl}/api/v2/workflows/{id}/events
	 *
	 * Used for approval gates and other event-driven patterns.
	 */
	raiseEvent: (
		orchestratorUrl: string,
		instanceId: string,
		eventName: string,
		eventData: unknown,
	): Promise<GenericRaiseEventResult> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}/events`, {
			method: "POST",
			body: JSON.stringify({
				eventName,
				eventData,
			}),
		}),

	/**
	 * Terminate a running workflow.
	 * Maps to: POST {orchestratorUrl}/api/v2/workflows/{id}/terminate
	 */
	terminateWorkflow: (
		orchestratorUrl: string,
		instanceId: string,
		reason?: string,
	): Promise<{ success: boolean; instanceId: string }> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}/terminate`, {
			method: "POST",
			body: JSON.stringify({ reason }),
		}),

	/**
	 * Purge a completed workflow instance from state store.
	 * Maps to: DELETE {orchestratorUrl}/api/v2/workflows/{id}
	 */
	purgeWorkflow: (
		orchestratorUrl: string,
		instanceId: string,
	): Promise<{ success: boolean; instanceId: string }> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}`, {
			method: "DELETE",
		}),
};
