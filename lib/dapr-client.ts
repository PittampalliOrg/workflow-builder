/**
 * Orchestrator API Client
 *
 * Proxy client that talks to the workflow-orchestrator's FastAPI endpoints.
 * The orchestratorUrl is stored per-workflow in the DB or configured via
 * WORKFLOW_ORCHESTRATOR_URL environment variable.
 *
 * Contract aligned with workflow-orchestrator service (Python/Dapr).
 */

import type { WorkflowDefinition } from "./workflow-definition";

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

// ─── Generic Orchestrator Client ────────────────────────────────────────────

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
	workflowName?: string;
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

export type GenericWorkflowListItem = {
	instanceId: string;
	workflowId: string;
	workflowName?: string;
	runtimeStatus: string;
	traceId?: string;
	phase?: string;
	progress?: number;
	message?: string;
	currentNodeId?: string;
	currentNodeName?: string;
	error?: string;
	startedAt?: string;
	completedAt?: string;
};

export type GenericWorkflowListResponse = {
	workflows: GenericWorkflowListItem[];
	total: number;
	limit: number;
	offset: number;
};

export type GenericWorkflowHistoryEvent = {
	eventId?: number | null;
	eventType: string;
	timestamp?: string | null;
	name?: string | null;
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown> | null;
	raw?: Record<string, unknown> | null;
};

export type GenericWorkflowHistoryResponse = {
	instanceId: string;
	events: GenericWorkflowHistoryEvent[];
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
 * Generic orchestrator client for the workflow-orchestrator service
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

	listWorkflows: (
		orchestratorUrl: string,
		options?: {
			search?: string;
			status?: string[];
			limit?: number;
			offset?: number;
		},
	): Promise<GenericWorkflowListResponse> => {
		const params = new URLSearchParams();
		if (options?.search?.trim()) params.set("search", options.search.trim());
		if (options?.status?.length) params.set("status", options.status.join(","));
		if (typeof options?.limit === "number") params.set("limit", String(options.limit));
		if (typeof options?.offset === "number") params.set("offset", String(options.offset));
		const query = params.toString();
		return daprFetch(
			`${orchestratorUrl}/api/v2/workflows${query ? `?${query}` : ""}`,
		);
	},

	getWorkflowHistory: (
		orchestratorUrl: string,
		instanceId: string,
	): Promise<GenericWorkflowHistoryResponse> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}/history`),

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
