/**
 * API Client for making type-safe API calls to the SvelteKit BFF endpoints.
 *
 * Simplified from the Next.js workflow-builder api-client.ts pattern.
 * All calls go through the SvelteKit server routes which proxy to
 * the Dapr orchestrator and other backend services.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Workflow {
	id: string;
	name: string;
	description?: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	visibility?: 'private' | 'public';
	createdAt: string;
	updatedAt: string;
}

export interface WorkflowNode {
	id: string;
	type: string;
	position: { x: number; y: number };
	data: Record<string, unknown>;
}

export interface WorkflowEdge {
	id: string;
	source: string;
	target: string;
}

export type ExecutionStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled';

export interface WorkflowExecution {
	id: string;
	workflowId: string;
	status: ExecutionStatus;
	daprInstanceId: string | null;
	runtimeStatus: string | null;
	phase: string | null;
	progress: number | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	input: Record<string, unknown> | null;
	output: unknown;
	error: string | null;
	traceId?: string | null;
	startedAt: string;
	completedAt: string | null;
	duration: string | null;
}

export interface ExecutionNodeStatus {
	nodeId: string;
	nodeName?: string;
	activityName?: string | null;
	status: 'pending' | 'running' | 'success' | 'error';
	timestamp?: string | null;
}

export interface ExecutionStatusResponse {
	executionId: string;
	instanceId: string | null;
	workflowId: string;
	status: ExecutionStatus;
	runtimeStatus: string | null;
	phase: string | null;
	progress: number | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	traceId?: string | null;
	traceIds: string[];
	sessionId: string | null;
	nodeStatuses: Record<string, string>;
	input: Record<string, unknown> | null;
	output: unknown;
	summaryOutput: Record<string, unknown> | null;
	browserArtifacts: Array<Record<string, unknown>>;
	agentRuns: Array<{
		id: string;
		workflowExecutionId: string;
		workflowId: string;
		nodeId: string;
		mode: 'run' | 'plan' | 'execute_plan';
		status: 'scheduled' | 'running' | 'completed' | 'failed' | 'event_published';
		agentWorkflowId: string;
		daprInstanceId: string;
		parentExecutionId: string;
		workspaceRef: string | null;
		artifactRef: string | null;
		result: Record<string, unknown> | null;
		error: string | null;
		createdAt: string | null;
		updatedAt: string | null;
		completedAt: string | null;
	}>;
	agentEvents: Array<{
		id: number;
		type: string;
		data: Record<string, unknown>;
		timestamp: string;
		workflowAgentRunId?: string | null;
		daprInstanceId?: string | null;
		phase?: string | null;
		toolName?: string | null;
	}>;
	lastAgentEventId: number;
	error: string | null;
	startedAt: string | null;
	completedAt: string | null;
}

export interface AppConnection {
	id: string;
	externalId: string;
	displayName: string;
	pieceName: string;
	type: 'OAUTH2' | 'SECRET_TEXT' | 'BASIC_AUTH' | 'CUSTOM_AUTH';
	status: 'active' | 'expired' | 'error';
	createdAt: string;
	updatedAt: string;
}

export interface CreateConnectionPayload {
	externalId: string;
	displayName: string;
	pieceName: string;
	type: AppConnection['type'];
	value: Record<string, unknown>;
}

export interface Trace {
	traceId: string;
	rootServiceName: string;
	rootSpanName: string;
	startTime: string;
	durationMs: number;
	spanCount: number;
	statusCode: string;
}

export interface TraceSpan {
	spanId: string;
	parentSpanId: string | null;
	operationName: string;
	serviceName: string;
	startTime: string;
	durationMs: number;
	statusCode: string;
	attributes: Record<string, unknown>;
	events: Array<{ name: string; timestamp: string; attributes: Record<string, unknown> }>;
}

export interface TraceDetail {
	traceId: string;
	spans: TraceSpan[];
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

export class ApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
	}
}

// ---------------------------------------------------------------------------
// Core helper
// ---------------------------------------------------------------------------

async function apiCall<T>(endpoint: string, options?: RequestInit): Promise<T> {
	let response = await fetch(endpoint, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			...options?.headers
		}
	});

	// Auto-refresh on 401
	if (response.status === 401) {
		const refreshRes = await fetch('/api/v1/auth/refresh', { method: 'POST' });
		if (refreshRes.ok) {
			response = await fetch(endpoint, {
				...options,
				headers: {
					'Content-Type': 'application/json',
					...options?.headers
				}
			});
		}
	}

	if (!response.ok) {
		const body = await response.json().catch(() => ({ error: 'Unknown error' }));
		const baseMessage =
			typeof body?.error === 'string' && body.error.length > 0
				? body.error
				: 'Request failed';
		const details =
			typeof body?.details === 'string' && body.details.length > 0
				? body.details
				: null;
		throw new ApiError(
			response.status,
			details ? `${baseMessage}: ${details}` : baseMessage
		);
	}

	return response.json();
}

// ---------------------------------------------------------------------------
// API namespaces
// ---------------------------------------------------------------------------

export const api = {
	workflow: {
		list: () => apiCall<Workflow[]>('/api/workflows'),

		get: (id: string) => apiCall<Workflow>(`/api/workflows/${id}`),

		create: (data: { name: string; description?: string }) =>
			apiCall<Workflow>('/api/workflows', {
				method: 'POST',
				body: JSON.stringify(data)
			}),

		update: (id: string, data: Partial<Workflow>) =>
			apiCall<Workflow>(`/api/workflows/${id}`, {
				method: 'PUT',
				body: JSON.stringify(data)
			}),

		delete: (id: string) =>
			apiCall<void>(`/api/workflows/${id}`, {
				method: 'DELETE'
			}),

		execute: (id: string, input: Record<string, unknown> = {}) =>
			apiCall<{ executionId: string; status: string }>(`/api/workflows/${id}/execute`, {
				method: 'POST',
				body: JSON.stringify({ input })
			}),

		getExecutions: (id: string) =>
			apiCall<WorkflowExecution[]>(`/api/workflows/${id}/executions`),

		getExecutionStatus: (executionId: string) =>
			apiCall<ExecutionStatusResponse>(
				`/api/workflows/executions/${executionId}/status`
			)
	},

	connection: {
		list: () =>
			apiCall<AppConnection[]>('/api/app-connections'),

		create: (data: CreateConnectionPayload) =>
			apiCall<AppConnection>('/api/app-connections', {
				method: 'POST',
				body: JSON.stringify(data)
			}),

		delete: (id: string) =>
			apiCall<void>(`/api/app-connections/${id}`, {
				method: 'DELETE'
			})
	},

	observability: {
		listTraces: (params?: { service?: string; limit?: number }) => {
			const search = new URLSearchParams();
			if (params?.service) search.set('service', params.service);
			if (params?.limit) search.set('limit', String(params.limit));
			const query = search.toString();
			return apiCall<Trace[]>(
				`/api/observability/traces${query ? `?${query}` : ''}`
			);
		},

		getTraceDetails: (traceId: string) =>
			apiCall<TraceDetail>(
				`/api/observability/traces/${encodeURIComponent(traceId)}`
			)
	}
};
