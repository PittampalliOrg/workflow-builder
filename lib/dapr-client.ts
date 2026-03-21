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

const RETRYABLE_ORCHESTRATOR_STATUS_CODES = new Set([408, 429, 502, 503, 504]);
const SAFE_RETRY_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_ORCHESTRATOR_RETRY_ATTEMPTS = 3;

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveRetryMethod(options?: RequestInit) {
	return (
		String(options?.method || "GET")
			.trim()
			.toUpperCase() || "GET"
	);
}

function isRetryableStatus(method: string, status: number) {
	return (
		SAFE_RETRY_METHODS.has(method) &&
		RETRYABLE_ORCHESTRATOR_STATUS_CODES.has(status)
	);
}

function isRetryableNetworkError(method: string, error: unknown) {
	if (!SAFE_RETRY_METHODS.has(method) || !(error instanceof Error)) {
		return false;
	}
	const code = (() => {
		const cause = (error as Error & { cause?: { code?: string } }).cause;
		return typeof cause?.code === "string" ? cause.code : "";
	})();
	return (
		code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED"
	);
}

async function daprFetch<T>(url: string, options?: RequestInit): Promise<T> {
	const method = resolveRetryMethod(options);
	const maxAttempts = SAFE_RETRY_METHODS.has(method)
		? DEFAULT_ORCHESTRATOR_RETRY_ATTEMPTS
		: 1;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const response = await fetch(url, {
				...options,
				headers: {
					"Content-Type": "application/json",
					...options?.headers,
				},
			});

			if (!response.ok) {
				if (
					attempt < maxAttempts &&
					isRetryableStatus(method, response.status)
				) {
					await sleep(attempt * 250);
					continue;
				}
				const errorBody = await response.text().catch(() => "Unknown error");
				throw new Error(
					`Dapr orchestrator error (${response.status}): ${errorBody}`,
				);
			}

			return response.json();
		} catch (error) {
			if (attempt < maxAttempts && isRetryableNetworkError(method, error)) {
				await sleep(attempt * 250);
				continue;
			}
			throw error;
		}
	}

	throw new Error(`Dapr orchestrator request failed for ${method} ${url}`);
}

// ─── Generic Orchestrator Client ────────────────────────────────────────────

/**
 * Response from POST /api/v2/workflows (generic orchestrator)
 */
export type GenericStartWorkflowResult = {
	instanceId: string;
	workflowId: string;
	status: string; // "started"
	workflowVersion?: string;
};

/**
 * Response from GET /api/v2/workflows/{id}/status (generic orchestrator)
 */
export type GenericWorkflowStatus = {
	instanceId: string;
	workflowId: string;
	workflowName?: string;
	workflowVersion?: string;
	workflowNameVersioned?: string;
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
	stackTrace?: string | null;
	parentInstanceId?: string | null;
	startedAt?: string;
	completedAt?: string;
};

export type GenericWorkflowListItem = {
	instanceId: string;
	workflowId: string;
	workflowName?: string;
	workflowVersion?: string;
	workflowNameVersioned?: string;
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
		workflowVersion?: string,
		headers?: Record<string, string>,
	): Promise<GenericStartWorkflowResult> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				definition,
				triggerData,
				integrations,
				dbExecutionId,
				nodeConnectionMap,
				workflowVersion,
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
		if (typeof options?.limit === "number")
			params.set("limit", String(options.limit));
		if (typeof options?.offset === "number")
			params.set("offset", String(options.offset));
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

	rerunWorkflow: (
		orchestratorUrl: string,
		instanceId: string,
		options?: { fromEventId?: number; reason?: string },
	): Promise<{
		success: boolean;
		sourceInstanceId: string;
		fromEventId: number;
		newInstanceId: string;
	}> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}/rerun`, {
			method: "POST",
			body: JSON.stringify({
				fromEventId: options?.fromEventId ?? 0,
				reason: options?.reason,
			}),
		}),

	pauseWorkflow: (
		orchestratorUrl: string,
		instanceId: string,
	): Promise<{ success: boolean; instanceId: string }> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}/pause`, {
			method: "POST",
		}),

	resumeWorkflow: (
		orchestratorUrl: string,
		instanceId: string,
	): Promise<{ success: boolean; instanceId: string }> =>
		daprFetch(`${orchestratorUrl}/api/v2/workflows/${instanceId}/resume`, {
			method: "POST",
		}),

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
		options?: { force?: boolean; recursive?: boolean },
	): Promise<{
		success: boolean;
		instanceId: string;
		force?: boolean;
		recursive?: boolean;
		deletedInstanceCount?: number;
		isComplete?: boolean;
	}> => {
		const params = new URLSearchParams();
		if (options?.force) params.set("force", "true");
		if (options?.recursive) params.set("recursive", "true");
		const query = params.toString();
		return daprFetch(
			`${orchestratorUrl}/api/v2/workflows/${instanceId}${query ? `?${query}` : ""}`,
			{
				method: "DELETE",
			},
		);
	},
};
