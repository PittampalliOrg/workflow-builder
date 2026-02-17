/**
 * API Client for making type-safe API calls to the backend
 * Replaces server actions with API endpoints
 */

import type {
	AppConnectionScope,
	AppConnectionStatus,
	AppConnectionValue,
	AppConnectionWithoutSensitiveData,
	UpdateConnectionValueRequestBody,
	UpsertAppConnectionRequestBody,
} from "./types/app-connection";
import type { IntegrationDefinition } from "./actions/types";
import type { McpInputProperty } from "./mcp/types";
import type {
	ObservabilityEntitiesResponse,
	ObservabilityTraceDetailsResponse,
	ObservabilityTraceFilters,
	ObservabilityTraceListResponse,
} from "./types/observability";
import type { WorkflowEdge, WorkflowNode } from "./workflow-store";

// Workflow data types
export type WorkflowVisibility = "private" | "public";

export type WorkflowData = {
	id?: string;
	name?: string;
	description?: string;
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
	visibility?: WorkflowVisibility;
};

export type SavedWorkflow = WorkflowData & {
	id: string;
	name: string;
	visibility: WorkflowVisibility;
	createdAt: string;
	updatedAt: string;
	isOwner?: boolean;
};

// API error class
export class ApiError extends Error {
	status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
		this.name = "ApiError";
	}
}

// Helper function to make API calls with automatic token refresh
async function apiCall<T>(endpoint: string, options?: RequestInit): Promise<T> {
	let response = await fetch(endpoint, {
		...options,
		headers: {
			"Content-Type": "application/json",
			...options?.headers,
		},
	});

	// Auto-refresh on 401
	if (response.status === 401) {
		const refreshRes = await fetch("/api/v1/auth/refresh", { method: "POST" });
		if (refreshRes.ok) {
			response = await fetch(endpoint, {
				...options,
				headers: {
					"Content-Type": "application/json",
					...options?.headers,
				},
			});
		}
	}

	if (!response.ok) {
		const error = await response
			.json()
			.catch(() => ({ error: "Unknown error" }));
		const baseMessage =
			typeof error?.error === "string" && error.error.length > 0
				? error.error
				: "Request failed";
		const details =
			typeof error?.details === "string" && error.details.length > 0
				? error.details
				: null;
		throw new ApiError(
			response.status,
			details ? `${baseMessage}: ${details}` : baseMessage,
		);
	}

	return response.json();
}

// AI API

type StreamMessage = {
	type: "operation" | "complete" | "error";
	operation?: {
		op:
			| "setName"
			| "setDescription"
			| "addNode"
			| "addEdge"
			| "removeNode"
			| "removeEdge"
			| "updateNode";
		name?: string;
		description?: string;
		node?: unknown;
		edge?: unknown;
		nodeId?: string;
		edgeId?: string;
		updates?: {
			position?: { x: number; y: number };
			data?: unknown;
		};
	};
	error?: string;
};

type StreamState = {
	buffer: string;
	currentData: WorkflowData;
};

export type WorkflowAiChatMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	operations: Array<Record<string, unknown>> | null;
	createdAt: string;
	updatedAt: string;
};

type OperationHandler = (
	op: StreamMessage["operation"],
	state: StreamState,
) => void;

function handleSetName(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (op?.name) {
		state.currentData.name = op.name;
	}
}

function handleSetDescription(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (op?.description) {
		state.currentData.description = op.description;
	}
}

function handleAddNode(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (op?.node) {
		state.currentData.nodes = [
			...state.currentData.nodes,
			op.node as WorkflowNode,
		];
	}
}

function handleAddEdge(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (op?.edge) {
		state.currentData.edges = [
			...state.currentData.edges,
			op.edge as WorkflowEdge,
		];
	}
}

function handleRemoveNode(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (op?.nodeId) {
		state.currentData.nodes = state.currentData.nodes.filter(
			(n) => n.id !== op.nodeId,
		);
		state.currentData.edges = state.currentData.edges.filter(
			(e) => e.source !== op.nodeId && e.target !== op.nodeId,
		);
	}
}

function handleRemoveEdge(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (op?.edgeId) {
		state.currentData.edges = state.currentData.edges.filter(
			(e) => e.id !== op.edgeId,
		);
	}
}

function handleUpdateNode(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (op?.nodeId && op.updates) {
		state.currentData.nodes = state.currentData.nodes.map((n) => {
			if (n.id === op.nodeId) {
				return {
					...n,
					...(op.updates?.position ? { position: op.updates.position } : {}),
					...(op.updates?.data
						? { data: { ...n.data, ...op.updates.data } }
						: {}),
				};
			}
			return n;
		});
	}
}

const operationHandlers: Record<string, OperationHandler> = {
	setName: handleSetName,
	setDescription: handleSetDescription,
	addNode: handleAddNode,
	addEdge: handleAddEdge,
	removeNode: handleRemoveNode,
	removeEdge: handleRemoveEdge,
	updateNode: handleUpdateNode,
};

function applyOperation(
	op: StreamMessage["operation"],
	state: StreamState,
): void {
	if (!op?.op) {
		return;
	}

	const handler = operationHandlers[op.op];
	if (handler) {
		handler(op, state);
	}
}

function processStreamLine(
	line: string,
	onUpdate: (data: WorkflowData) => void,
	state: StreamState,
): void {
	if (!line.trim()) {
		return;
	}

	try {
		const message = JSON.parse(line) as StreamMessage;

		if (message.type === "operation" && message.operation) {
			applyOperation(message.operation, state);
			onUpdate({ ...state.currentData });
		} else if (message.type === "error") {
			console.error("[API Client] Error:", message.error);
			throw new Error(message.error);
		}
	} catch (error) {
		console.error("[API Client] Failed to parse JSONL line:", error);
		throw error instanceof Error
			? error
			: new Error("Failed to parse workflow stream");
	}
}

function processStreamChunk(
	value: Uint8Array,
	decoder: TextDecoder,
	onUpdate: (data: WorkflowData) => void,
	state: StreamState,
): void {
	state.buffer += decoder.decode(value, { stream: true });

	// Process complete JSONL lines
	const lines = state.buffer.split("\n");
	state.buffer = lines.pop() || "";

	for (const line of lines) {
		processStreamLine(line, onUpdate, state);
	}
}

async function streamWorkflowOperations(
	endpoint: string,
	body: Record<string, unknown>,
	onUpdate: (data: WorkflowData) => void,
	existingWorkflow?: {
		nodes: WorkflowNode[];
		edges: WorkflowEdge[];
		name?: string;
	},
): Promise<WorkflowData> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		let message = `HTTP error! status: ${response.status}`;
		try {
			const payload = (await response.json()) as unknown;
			if (
				typeof payload === "object" &&
				payload !== null &&
				"error" in payload &&
				typeof (payload as { error?: unknown }).error === "string"
			) {
				message = (payload as { error: string }).error;
			} else if (
				typeof payload === "object" &&
				payload !== null &&
				"message" in payload &&
				typeof (payload as { message?: unknown }).message === "string"
			) {
				message = (payload as { message: string }).message;
			}
		} catch {
			// Best effort: some routes might return plain text on failure.
			const text = await response.text().catch(() => "");
			if (text.trim()) {
				message = `${message}: ${text.trim()}`;
			}
		}

		throw new ApiError(response.status, message);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const state: StreamState = {
		buffer: "",
		currentData: existingWorkflow
			? {
					nodes: existingWorkflow.nodes || [],
					edges: existingWorkflow.edges || [],
					name: existingWorkflow.name,
				}
			: { nodes: [], edges: [] },
	};

	try {
		while (true) {
			const { done, value } = await reader.read();

			if (done) {
				break;
			}

			processStreamChunk(value, decoder, onUpdate, state);
		}

		return state.currentData;
	} finally {
		reader.releaseLock();
	}
}

export const aiApi = {
	generate: (
		prompt: string,
		existingWorkflow?: {
			nodes: WorkflowNode[];
			edges: WorkflowEdge[];
			name?: string;
		},
		options?: { mode?: "validated" | "classic" },
	) =>
		apiCall<WorkflowData>("/api/ai/generate", {
			method: "POST",
			body: JSON.stringify({
				prompt,
				existingWorkflow,
				mode: options?.mode,
			}),
		}),
	generateStream: async (
		prompt: string,
		onUpdate: (data: WorkflowData) => void,
		existingWorkflow?: {
			nodes: WorkflowNode[];
			edges: WorkflowEdge[];
			name?: string;
		},
		options?: { mode?: "validated" | "classic" },
	): Promise<WorkflowData> =>
		streamWorkflowOperations(
			"/api/ai/generate",
			{ prompt, existingWorkflow, mode: options?.mode },
			onUpdate,
			existingWorkflow,
		),
};

export const aiChatApi = {
	getMessages: (workflowId: string) =>
		apiCall<{ messages: WorkflowAiChatMessage[] }>(
			`/api/workflows/${workflowId}/ai-chat/messages`,
		),

	generateStream: (
		workflowId: string,
		message: string,
		onUpdate: (data: WorkflowData) => void,
		existingWorkflow?: {
			nodes: WorkflowNode[];
			edges: WorkflowEdge[];
			name?: string;
		},
		options?: { mode?: "validated" | "classic" },
	): Promise<WorkflowData> =>
		streamWorkflowOperations(
			`/api/workflows/${workflowId}/ai-chat/stream`,
			{ message, existingWorkflow, mode: options?.mode },
			onUpdate,
			existingWorkflow,
		),
};

// User API
export const userApi = {
	get: () =>
		apiCall<{
			id: string;
			name: string | null;
			email: string;
			image: string | null;
			providerId: string | null;
		}>("/api/user"),

	update: (data: { name?: string; email?: string }) =>
		apiCall<{ success: boolean }>("/api/user", {
			method: "PATCH",
			body: JSON.stringify(data),
		}),
};

// Workflow API
export const workflowApi = {
	// Get all workflows
	getAll: () => apiCall<SavedWorkflow[]>("/api/workflows"),

	// Get a specific workflow
	getById: async (id: string): Promise<SavedWorkflow | null> => {
		try {
			return await apiCall<SavedWorkflow>(`/api/workflows/${id}`);
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) {
				return null;
			}
			throw error;
		}
	},

	// Create a new workflow
	create: (workflow: Omit<WorkflowData, "id">) =>
		apiCall<SavedWorkflow>("/api/workflows/create", {
			method: "POST",
			body: JSON.stringify(workflow),
		}),

	// Update a workflow
	update: (id: string, workflow: Partial<WorkflowData>) =>
		apiCall<SavedWorkflow>(`/api/workflows/${id}`, {
			method: "PATCH",
			body: JSON.stringify(workflow),
		}),

	// Delete a workflow
	delete: (id: string) =>
		apiCall<{ success: boolean }>(`/api/workflows/${id}`, {
			method: "DELETE",
		}),

	// Duplicate a workflow
	duplicate: (id: string) =>
		apiCall<SavedWorkflow>(`/api/workflows/${id}/duplicate`, {
			method: "POST",
		}),

	// Get current workflow state
	getCurrent: () => apiCall<WorkflowData>("/api/workflows/current"),

	// Save current workflow state
	saveCurrent: (nodes: WorkflowNode[], edges: WorkflowEdge[]) =>
		apiCall<WorkflowData>("/api/workflows/current", {
			method: "POST",
			body: JSON.stringify({ nodes, edges }),
		}),

	// Execute workflow
	execute: (id: string, input: Record<string, unknown> = {}) =>
		apiCall<{
			executionId: string;
			status: string;
			output?: unknown;
			error?: string;
			duration?: number;
		}>(`/api/workflow/${id}/execute`, {
			method: "POST",
			body: JSON.stringify({ input }),
		}),

	// Trigger workflow via webhook
	triggerWebhook: (id: string, input: Record<string, unknown> = {}) =>
		apiCall<{
			executionId: string;
			status: string;
		}>(`/api/workflows/${id}/webhook`, {
			method: "POST",
			body: JSON.stringify(input),
		}),

	// Get workflow code
	getCode: (id: string) =>
		apiCall<{ code: string; workflowName: string }>(
			`/api/workflows/${id}/code`,
		),

	// Get executions
	getExecutions: (id: string) =>
		apiCall<
			Array<{
				id: string;
				workflowId: string;
				userId: string;
				status: string;
				input: Record<string, unknown> | null;
				output: unknown;
				error: string | null;
				startedAt: Date;
				completedAt: Date | null;
				duration: string | null;
				// Dapr execution fields
				daprInstanceId: string | null;
				phase: string | null;
				progress: number | null;
			}>
		>(`/api/workflows/${id}/executions`),

	// Delete executions
	deleteExecutions: (id: string) =>
		apiCall<{ success: boolean; deletedCount: number }>(
			`/api/workflows/${id}/executions`,
			{
				method: "DELETE",
			},
		),

	// Get execution logs
	getExecutionLogs: (executionId: string) =>
		apiCall<{
			execution: {
				id: string;
				workflowId: string;
				userId: string;
				status: string;
				input: unknown;
				output: unknown;
				error: string | null;
				startedAt: Date;
				completedAt: Date | null;
				duration: string | null;
				daprInstanceId: string | null;
				phase: string | null;
				progress: number | null;
				workflow: {
					id: string;
					name: string;
					nodes: unknown;
					edges: unknown;
				};
			};
			logs: Array<{
				id: string;
				executionId: string;
				nodeId: string;
				nodeName: string;
				nodeType: string;
				actionType?: string | null; // Function slug like "openai/generate-text"
				status: "pending" | "running" | "success" | "error";
				input: unknown;
				output: unknown;
				error: string | null;
				startedAt: Date;
				completedAt: Date | null;
				duration: string | null;
			}>;
		}>(`/api/workflows/executions/${executionId}/logs`),

	// Get execution status
	getExecutionStatus: (executionId: string) =>
		apiCall<{
			status: string;
			nodeStatuses: Array<{
				nodeId: string;
				status: "pending" | "running" | "success" | "error";
			}>;
		}>(`/api/workflows/executions/${executionId}/status`),

	// Download workflow
	download: (id: string) =>
		apiCall<{
			success: boolean;
			files?: Record<string, string>;
			error?: string;
		}>(`/api/workflows/${id}/download`),

	// Create workflow from WorkflowSpec JSON
	createFromSpec: (input: {
		name?: string;
		description?: string;
		spec: unknown;
	}) =>
		apiCall<{
			workflow: SavedWorkflow;
			issues: { errors: unknown[]; warnings: unknown[] };
		}>("/api/workflows/create-from-spec", {
			method: "POST",
			body: JSON.stringify(input),
		}),

	// Auto-save with debouncing (kept for backwards compatibility)
	autoSaveCurrent: (() => {
		let autosaveTimeout: NodeJS.Timeout | null = null;
		const AUTOSAVE_DELAY = 2000;

		return (nodes: WorkflowNode[], edges: WorkflowEdge[]): void => {
			if (autosaveTimeout) {
				clearTimeout(autosaveTimeout);
			}

			autosaveTimeout = setTimeout(() => {
				workflowApi.saveCurrent(nodes, edges).catch((error) => {
					console.error("Auto-save failed:", error);
				});
			}, AUTOSAVE_DELAY);
		};
	})(),

	// Auto-save specific workflow with debouncing
	autoSaveWorkflow: (() => {
		let autosaveTimeout: NodeJS.Timeout | null = null;
		const AUTOSAVE_DELAY = 2000;

		return (
			id: string,
			data: Partial<WorkflowData>,
			debounce = true,
		): Promise<SavedWorkflow> | undefined => {
			if (!debounce) {
				return workflowApi.update(id, data);
			}

			if (autosaveTimeout) {
				clearTimeout(autosaveTimeout);
			}

			autosaveTimeout = setTimeout(() => {
				workflowApi.update(id, data).catch((error) => {
					console.error("Auto-save failed:", error);
				});
			}, AUTOSAVE_DELAY);
		};
	})(),
};

// Dapr Workflow API
export type DaprWorkflowStatusResponse = {
	executionId: string;
	daprInstanceId: string;
	status: string;
	daprStatus: string;
	phase: string | null;
	progress: number | null;
	message: string | null;
	currentActivity: string | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	approvalEventName: string | null;
	createdAt?: string;
	lastUpdatedAt?: string;
};

export const daprApi = {
	// Get Dapr workflow status
	getStatus: (executionId: string) =>
		apiCall<DaprWorkflowStatusResponse>(
			`/api/dapr/workflows/${executionId}/status`,
		),

	// Raise an external event on a workflow execution (approval gates)
	raiseEvent: (executionId: string, eventName: string, eventData: unknown) =>
		apiCall<{ success: boolean }>(
			`/api/orchestrator/workflows/${executionId}/events`,
			{
				method: "POST",
				body: JSON.stringify({ eventName, eventData }),
			},
		),
};

// Functions API types
export type FunctionSummary = {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	pluginId: string;
	version: string;
	executionType: "builtin" | "oci" | "http";
	integrationType: string | null;
	isBuiltin: boolean | null;
	isEnabled: boolean | null;
	isDeprecated: boolean | null;
	createdAt: Date;
	updatedAt: Date;
};

export type FunctionDefinition = FunctionSummary & {
	imageRef: string | null;
	command: string | null;
	workingDir: string | null;
	containerEnv: Record<string, string> | null;
	webhookUrl: string | null;
	webhookMethod: string | null;
	webhookHeaders: Record<string, string> | null;
	webhookTimeoutSeconds: number | null;
	inputSchema: unknown;
	outputSchema: unknown;
	timeoutSeconds: number | null;
	retryPolicy: unknown;
	maxConcurrency: number | null;
	createdBy: string | null;
};

export const functionsApi = {
	// List all functions
	getAll: (options?: {
		pluginId?: string;
		executionType?: "builtin" | "oci" | "http";
		integrationType?: string;
		search?: string;
		includeDisabled?: boolean;
	}) => {
		const params = new URLSearchParams();
		if (options?.pluginId) params.set("pluginId", options.pluginId);
		if (options?.executionType)
			params.set("executionType", options.executionType);
		if (options?.integrationType)
			params.set("integrationType", options.integrationType);
		if (options?.search) params.set("search", options.search);
		if (options?.includeDisabled) params.set("includeDisabled", "true");
		const queryString = params.toString();
		return apiCall<{ functions: FunctionSummary[] }>(
			`/api/functions${queryString ? `?${queryString}` : ""}`,
		);
	},

	// Get a function by ID
	getById: (id: string) => apiCall<FunctionDefinition>(`/api/functions/${id}`),

	// Create a new function
	create: (data: {
		name: string;
		slug: string;
		description?: string;
		pluginId: string;
		version?: string;
		executionType: "builtin" | "oci" | "http";
		imageRef?: string;
		command?: string;
		workingDir?: string;
		containerEnv?: Record<string, string>;
		webhookUrl?: string;
		webhookMethod?: string;
		webhookHeaders?: Record<string, string>;
		webhookTimeoutSeconds?: number;
		inputSchema?: unknown;
		outputSchema?: unknown;
		timeoutSeconds?: number;
		maxConcurrency?: number;
		integrationType?: string;
	}) =>
		apiCall<FunctionSummary>("/api/functions", {
			method: "POST",
			body: JSON.stringify(data),
		}),

	// Update a function
	update: (
		id: string,
		data: Partial<{
			name: string;
			description: string;
			pluginId: string;
			version: string;
			executionType: "builtin" | "oci" | "http";
			imageRef: string;
			command: string;
			workingDir: string;
			containerEnv: Record<string, string>;
			webhookUrl: string;
			webhookMethod: string;
			webhookHeaders: Record<string, string>;
			webhookTimeoutSeconds: number;
			inputSchema: unknown;
			outputSchema: unknown;
			timeoutSeconds: number;
			maxConcurrency: number;
			integrationType: string;
			isEnabled: boolean;
		}>,
	) =>
		apiCall<FunctionDefinition>(`/api/functions/${id}`, {
			method: "PATCH",
			body: JSON.stringify(data),
		}),

	// Delete (disable) a function
	delete: (id: string) =>
		apiCall<{ success: boolean; error?: string }>(`/api/functions/${id}`, {
			method: "DELETE",
		}),
};

// Infrastructure Secrets types
export type InfrastructureSecret = {
	key: string;
	integrationType: string;
	label: string;
	envVar: string;
	source: "azure-keyvault";
};

export type InfrastructureSecretsResponse = {
	available: boolean;
	secretStoreConnected: boolean;
	secrets: InfrastructureSecret[];
};

// Secrets API
export const secretsApi = {
	// Get available infrastructure secrets from Dapr/Azure Key Vault
	getAvailable: () =>
		apiCall<InfrastructureSecretsResponse>("/api/secrets/available"),
};

function buildObservabilityQuery(filters?: ObservabilityTraceFilters): string {
	if (!filters) {
		return "";
	}

	const params = new URLSearchParams();

	if (filters.entityType) {
		params.set("entityType", filters.entityType);
	}
	if (filters.entityId) {
		params.set("entityId", filters.entityId);
	}
	if (filters.from) {
		params.set("from", filters.from);
	}
	if (filters.to) {
		params.set("to", filters.to);
	}
	if (filters.cursor) {
		params.set("cursor", filters.cursor);
	}
	if (filters.limit) {
		params.set("limit", String(filters.limit));
	}
	if (filters.search) {
		params.set("search", filters.search);
	}

	const query = params.toString();
	return query ? `?${query}` : "";
}

export const observabilityApi = {
	getEntities: () =>
		apiCall<ObservabilityEntitiesResponse>("/api/observability/entities"),

	getTraces: (filters?: ObservabilityTraceFilters) =>
		apiCall<ObservabilityTraceListResponse>(
			`/api/observability/traces${buildObservabilityQuery(filters)}`,
		),

	getTrace: (traceId: string) =>
		apiCall<ObservabilityTraceDetailsResponse>(
			`/api/observability/traces/${encodeURIComponent(traceId)}`,
		),
};

export type AppConnection = AppConnectionWithoutSensitiveData & {
	createdAt: string;
	updatedAt: string;
};

export type AppConnectionWithValue = Omit<
	AppConnectionWithoutSensitiveData,
	"createdAt" | "updatedAt"
> & {
	value: AppConnectionValue;
	createdAt: string;
	updatedAt: string;
};

export type PieceMetadata = {
	id: string;
	name: string;
	authors: string[];
	displayName: string;
	logoUrl: string;
	description: string | null;
	platformId: string | null;
	version: string;
	minimumSupportedRelease: string;
	maximumSupportedRelease: string;
	auth: unknown;
	actions: Record<string, unknown>;
	triggers: Record<string, unknown>;
	pieceType: string;
	categories: string[];
	packageType: string;
	i18n: unknown;
	createdAt: string;
	updatedAt: string;
};

export type PieceMetadataSummary = Pick<
	PieceMetadata,
	| "id"
	| "name"
	| "authors"
	| "displayName"
	| "logoUrl"
	| "description"
	| "platformId"
	| "version"
	| "minimumSupportedRelease"
	| "maximumSupportedRelease"
	| "auth"
	| "pieceType"
	| "categories"
	| "packageType"
	| "createdAt"
	| "updatedAt"
>;

// Pieces API
export const pieceApi = {
	list: (params?: {
		searchQuery?: string;
		categories?: string[];
		limit?: number;
	}) => {
		const search = new URLSearchParams();
		if (params?.searchQuery) search.set("searchQuery", params.searchQuery);
		if (params?.limit) search.set("limit", String(params.limit));
		if (params?.categories) {
			for (const category of params.categories) {
				search.append("categories", category);
			}
		}
		const query = search.toString();
		return apiCall<PieceMetadataSummary[]>(
			`/api/pieces${query ? `?${query}` : ""}`,
		);
	},

	get: (name: string, version?: string) =>
		apiCall<PieceMetadata>(
			`/api/pieces/${encodeURIComponent(name)}${
				version ? `?version=${encodeURIComponent(version)}` : ""
			}`,
		),

	/**
	 * Returns ActivePieces actions for the action picker.
	 * - Default: installed pieces only
	 * - With searchQuery: searches across all synced pieces
	 */
	actions: (params?: {
		searchQuery?: string;
		limit?: number;
		scope?: "installed" | "all";
	}) => {
		const search = new URLSearchParams();
		if (params?.searchQuery) search.set("searchQuery", params.searchQuery);
		if (params?.limit) search.set("limit", String(params.limit));
		if (params?.scope) search.set("scope", params.scope);
		const query = search.toString();
		return apiCall<{ pieces: IntegrationDefinition[] }>(
			`/api/pieces/actions${query ? `?${query}` : ""}`,
		);
	},
};

// Activepieces-style app connections API
export const appConnectionApi = {
	list: (query?: {
		projectId?: string;
		pieceName?: string;
		displayName?: string;
		scope?: AppConnectionScope;
		status?: AppConnectionStatus[];
		limit?: number;
	}) => {
		const search = new URLSearchParams();
		search.set("projectId", query?.projectId ?? "default");

		if (query?.pieceName) search.set("pieceName", query.pieceName);
		if (query?.displayName) search.set("displayName", query.displayName);
		if (query?.scope) search.set("scope", query.scope);
		if (query?.status) {
			for (const status of query.status) {
				search.append("status", status);
			}
		}
		if (query?.limit) search.set("limit", String(query.limit));

		return apiCall<{
			data: AppConnection[];
			next: string | null;
			previous: string | null;
		}>(`/api/app-connections?${search.toString()}`);
	},

	get: (id: string) =>
		apiCall<AppConnectionWithValue>(`/api/app-connections/${id}`),

	upsert: (body: UpsertAppConnectionRequestBody) =>
		apiCall<AppConnection>("/api/app-connections", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	update: (id: string, body: UpdateConnectionValueRequestBody) =>
		apiCall<AppConnection>(`/api/app-connections/${id}`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	delete: (id: string) =>
		apiCall<{ success: boolean }>(`/api/app-connections/${id}`, {
			method: "DELETE",
		}),

	test: (body: Partial<UpsertAppConnectionRequestBody>) =>
		apiCall<{ status: "success" | "error"; message: string }>(
			"/api/app-connections/test",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		),

	testExisting: (id: string) =>
		apiCall<{ status: "success" | "error"; message: string }>(
			`/api/app-connections/${id}/test`,
			{
				method: "POST",
			},
		),

	rename: (id: string, displayName: string) =>
		apiCall<AppConnection>(`/api/app-connections/${id}`, {
			method: "POST",
			body: JSON.stringify({ displayName }),
		}),

	bulkDelete: (ids: string[]) =>
		Promise.all(ids.map((id) => appConnectionApi.delete(id))),

	oauth2Start: (body: {
		pieceName: string;
		pieceVersion?: string;
		clientId?: string;
		redirectUrl?: string;
		props?: Record<string, unknown>;
	}) =>
		apiCall<{
			authorizationUrl: string;
			clientId: string;
			state: string;
			codeVerifier: string;
			codeChallenge: string;
			redirectUrl: string;
			scope: string;
		}>("/api/app-connections/oauth2/start", {
			method: "POST",
			body: JSON.stringify(body),
		}),
};

// OAuth Apps API (platform-level OAuth credentials per piece)
export type OAuthAppSummary = {
	pieceName: string;
	clientId: string;
	createdAt: string;
	updatedAt: string;
};

const oauthAppApi = {
	list: () => apiCall<OAuthAppSummary[]>("/api/oauth-apps"),

	upsert: (body: {
		pieceName: string;
		clientId: string;
		clientSecret: string;
	}) =>
		apiCall<{ success: boolean }>("/api/oauth-apps", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	delete: (pieceName: string) =>
		apiCall<{ success: boolean }>(
			`/api/oauth-apps?pieceName=${encodeURIComponent(pieceName)}`,
			{ method: "DELETE" },
		),
};

export type McpServerStatus = "ENABLED" | "DISABLED";

export type PopulatedMcpWorkflow = {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	trigger: {
		toolName: string;
		toolDescription: string;
		inputSchema: McpInputProperty[];
		returnsResponse: boolean;
	};
};

export type PopulatedMcpServer = {
	id: string;
	projectId: string;
	status: McpServerStatus;
	token: string;
	flows: PopulatedMcpWorkflow[];
	createdAt: string;
	updatedAt: string;
};

const mcpServerApi = {
	get: (projectId: string) =>
		apiCall<PopulatedMcpServer>(`/api/v1/projects/${projectId}/mcp-server`),

	update: (projectId: string, body: { status: McpServerStatus }) =>
		apiCall<PopulatedMcpServer>(`/api/v1/projects/${projectId}/mcp-server`, {
			method: "POST",
			body: JSON.stringify(body),
		}),

	rotate: (projectId: string) =>
		apiCall<PopulatedMcpServer>(
			`/api/v1/projects/${projectId}/mcp-server/rotate`,
			{ method: "POST" },
		),
};

// ── Resource Library API ─────────────────────────────────────

export type ResourcePromptData = {
	id: string;
	name: string;
	description: string | null;
	systemPrompt: string;
	userPrompt: string | null;
	promptMode: "system" | "system+user";
	metadata: Record<string, unknown> | null;
	version: number;
	isEnabled: boolean;
	userId: string;
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ResourceSchemaData = {
	id: string;
	name: string;
	description: string | null;
	schemaType: "json-schema";
	schema: unknown;
	metadata: Record<string, unknown> | null;
	version: number;
	isEnabled: boolean;
	userId: string;
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ResourceModelProfileData = {
	id: string;
	name: string;
	description: string | null;
	model: AgentModelSpec;
	defaultOptions: Record<string, unknown> | null;
	maxTurns: number | null;
	timeoutMinutes: number | null;
	metadata: Record<string, unknown> | null;
	version: number;
	isEnabled: boolean;
	userId: string;
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
};

export type ProfileWarningSeverity = "info" | "warning" | "error";

export type ProfileCompatibilityWarningData = {
	code: string;
	severity: ProfileWarningSeverity;
	message: string;
	field?: string;
	suggestedAction?: string;
};

export type AgentProfileSnapshotData = {
	agentType: string;
	instructions: string;
	model: AgentModelSpec;
	tools: AgentToolRef[];
	maxTurns: number;
	timeoutMinutes: number;
	defaultOptions: Record<string, unknown> | null;
	memoryConfig: Record<string, unknown> | null;
};

export type AgentProfileListItemData = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	category: string | null;
	isEnabled: boolean;
	sortOrder: number;
	sourceRepoUrl: string | null;
	sourcePath: string | null;
	defaultVersion: number;
	snapshotPreview: {
		agentType: string;
		modelId: string;
		toolCount: number;
		maxTurns: number;
		timeoutMinutes: number;
	};
	warnings: ProfileCompatibilityWarningData[];
};

export type AgentProfileDetailData = {
	template: {
		id: string;
		slug: string;
		name: string;
		description: string | null;
		category: string | null;
		sourceRepoUrl: string | null;
		sourcePath: string | null;
		isEnabled: boolean;
		sortOrder: number;
		createdAt: string;
		updatedAt: string;
	};
	templateVersion: {
		id: string;
		templateId: string;
		version: number;
		instructionFacetVersionId: string | null;
		modelFacetVersionId: string | null;
		toolPolicyFacetVersionId: string | null;
		memoryFacetVersionId: string | null;
		executionFacetVersionId: string | null;
		interactionFacetVersionId: string | null;
		outputFacetVersionId: string | null;
		capabilityFacetVersionId: string | null;
		compatibility: ProfileCompatibilityWarningData[] | null;
		notes: string | null;
		isDefault: boolean;
		createdAt: string;
		updatedAt: string;
	};
	snapshot: AgentProfileSnapshotData;
	warnings: ProfileCompatibilityWarningData[];
	examples: Array<{
		id: string;
		templateId: string;
		label: string;
		sourceRepoUrl: string;
		sourcePath: string;
		notes: string | null;
		createdAt: string;
		updatedAt: string;
	}>;
};

export type AgentProfilePreviewData = {
	templateId: string;
	templateVersion: number;
	snapshot: AgentProfileSnapshotData;
	warnings: ProfileCompatibilityWarningData[];
};

export type ModelCatalogModelData = {
	id: string;
	providerId: string;
	providerName: string;
	iconKey: string;
	modelKey: string;
	modelId: string;
	displayName: string;
	description: string | null;
};

const resourceApi = {
	models: {
		list: () =>
			apiCall<{ data: ModelCatalogModelData[] }>("/api/resources/models").then(
				(res) => res.data,
			),
	},
	prompts: {
		list: () =>
			apiCall<{ data: ResourcePromptData[] }>("/api/resources/prompts").then(
				(res) => res.data,
			),
		get: (id: string) =>
			apiCall<ResourcePromptData>(`/api/resources/prompts/${id}`),
		create: (
			body: Omit<
				ResourcePromptData,
				"id" | "version" | "userId" | "createdAt" | "updatedAt"
			>,
		) =>
			apiCall<ResourcePromptData>("/api/resources/prompts", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		update: (
			id: string,
			body: Partial<
				Omit<
					ResourcePromptData,
					"id" | "version" | "userId" | "createdAt" | "updatedAt" | "projectId"
				>
			>,
		) =>
			apiCall<ResourcePromptData>(`/api/resources/prompts/${id}`, {
				method: "PATCH",
				body: JSON.stringify(body),
			}),
		delete: (id: string) =>
			apiCall<{ success: boolean }>(`/api/resources/prompts/${id}`, {
				method: "DELETE",
			}),
	},
	schemas: {
		list: () =>
			apiCall<{ data: ResourceSchemaData[] }>("/api/resources/schemas").then(
				(res) => res.data,
			),
		get: (id: string) =>
			apiCall<ResourceSchemaData>(`/api/resources/schemas/${id}`),
		create: (
			body: Omit<
				ResourceSchemaData,
				"id" | "version" | "userId" | "createdAt" | "updatedAt"
			>,
		) =>
			apiCall<ResourceSchemaData>("/api/resources/schemas", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		update: (
			id: string,
			body: Partial<
				Omit<
					ResourceSchemaData,
					"id" | "version" | "userId" | "createdAt" | "updatedAt" | "projectId"
				>
			>,
		) =>
			apiCall<ResourceSchemaData>(`/api/resources/schemas/${id}`, {
				method: "PATCH",
				body: JSON.stringify(body),
			}),
		delete: (id: string) =>
			apiCall<{ success: boolean }>(`/api/resources/schemas/${id}`, {
				method: "DELETE",
			}),
	},
	modelProfiles: {
		list: () =>
			apiCall<{ data: ResourceModelProfileData[] }>(
				"/api/resources/model-profiles",
			).then((res) => res.data),
		get: (id: string) =>
			apiCall<ResourceModelProfileData>(`/api/resources/model-profiles/${id}`),
		create: (
			body: Omit<
				ResourceModelProfileData,
				"id" | "version" | "userId" | "createdAt" | "updatedAt"
			>,
		) =>
			apiCall<ResourceModelProfileData>("/api/resources/model-profiles", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		update: (
			id: string,
			body: Partial<
				Omit<
					ResourceModelProfileData,
					"id" | "version" | "userId" | "createdAt" | "updatedAt" | "projectId"
				>
			>,
		) =>
			apiCall<ResourceModelProfileData>(`/api/resources/model-profiles/${id}`, {
				method: "PATCH",
				body: JSON.stringify(body),
			}),
		delete: (id: string) =>
			apiCall<{ success: boolean }>(`/api/resources/model-profiles/${id}`, {
				method: "DELETE",
			}),
	},
	agentProfiles: {
		list: () =>
			apiCall<{ data: AgentProfileListItemData[] }>(
				"/api/resources/agent-profiles",
			).then((res) => res.data),
		get: (id: string, version?: number) => {
			const query =
				version === undefined
					? ""
					: `?${new URLSearchParams({ version: String(version) }).toString()}`;
			return apiCall<AgentProfileDetailData>(
				`/api/resources/agent-profiles/${id}${query}`,
			);
		},
		preview: (id: string, body?: { version?: number }) =>
			apiCall<AgentProfilePreviewData>(
				`/api/resources/agent-profiles/${id}/preview`,
				{
					method: "POST",
					body: JSON.stringify(body ?? {}),
				},
			),
		apply: (
			id: string,
			body: {
				agentId: string;
				version?: number;
			},
		) =>
			apiCall<AgentProfilePreviewData>(
				`/api/resources/agent-profiles/${id}/apply`,
				{
					method: "POST",
					body: JSON.stringify(body),
				},
			),
	},
};

// ── Agent API ─────────────────────────────────────────────────

export type AgentModelSpec = {
	provider: string;
	name: string;
};

export type AgentToolRef = {
	type: "workspace" | "mcp" | "action";
	ref: string;
};

export type AgentData = {
	id: string;
	name: string;
	description: string | null;
	agentType: string;
	instructions: string;
	model: AgentModelSpec;
	tools: AgentToolRef[];
	maxTurns: number;
	timeoutMinutes: number;
	defaultOptions: Record<string, unknown> | null;
	memoryConfig: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
	isDefault: boolean;
	isEnabled: boolean;
	instructionsPresetId: string | null;
	instructionsPresetVersion: number | null;
	schemaPresetId: string | null;
	schemaPresetVersion: number | null;
	modelProfileId: string | null;
	modelProfileVersion: number | null;
	agentProfileTemplateId: string | null;
	agentProfileTemplateVersion: number | null;
	userId: string;
	projectId: string | null;
	createdAt: string;
	updatedAt: string;
};

export type CreateAgentBody = {
	name: string;
	description?: string;
	agentType?: string;
	instructions: string;
	model: AgentModelSpec;
	tools?: AgentToolRef[];
	maxTurns?: number;
	timeoutMinutes?: number;
	defaultOptions?: Record<string, unknown>;
	memoryConfig?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
	instructionsPresetId?: string | null;
	schemaPresetId?: string | null;
	modelProfileId?: string | null;
	agentProfileTemplateId?: string | null;
	isDefault?: boolean;
	isEnabled?: boolean;
	projectId?: string;
};

export type UpdateAgentBody = Partial<CreateAgentBody>;

const agentApi = {
	list: () =>
		apiCall<{ data: AgentData[] }>("/api/agents").then((res) => res.data),

	get: (agentId: string) => apiCall<AgentData>(`/api/agents/${agentId}`),

	create: (body: CreateAgentBody) =>
		apiCall<AgentData>("/api/agents", {
			method: "POST",
			body: JSON.stringify(body),
		}),

	update: (agentId: string, body: UpdateAgentBody) =>
		apiCall<AgentData>(`/api/agents/${agentId}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		}),

	delete: (agentId: string) =>
		apiCall<{ success: boolean }>(`/api/agents/${agentId}`, {
			method: "DELETE",
		}),

	duplicate: (agentId: string) =>
		apiCall<AgentData>(`/api/agents/${agentId}/duplicate`, {
			method: "POST",
		}),
};

// Export all APIs as a single object
export const api = {
	agent: agentApi,
	ai: aiApi,
	aiChat: aiChatApi,
	appConnection: appConnectionApi,
	dapr: daprApi,
	functions: functionsApi,
	mcpServer: mcpServerApi,
	observability: observabilityApi,
	oauthApp: oauthAppApi,
	piece: pieceApi,
	resource: resourceApi,
	secrets: secretsApi,
	user: userApi,
	workflow: workflowApi,
};
