/**
 * API Client for making type-safe API calls to the backend
 * Replaces server actions with API endpoints
 */

import type { IntegrationConfig, IntegrationType } from "./types/integration";
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

// Helper function to make API calls
async function apiCall<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(endpoint, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: "Unknown error" }));
    throw new ApiError(response.status, error.error || "Request failed");
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

type OperationHandler = (
  op: StreamMessage["operation"],
  state: StreamState
) => void;

function handleSetName(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.name) {
    state.currentData.name = op.name;
  }
}

function handleSetDescription(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.description) {
    state.currentData.description = op.description;
  }
}

function handleAddNode(
  op: StreamMessage["operation"],
  state: StreamState
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
  state: StreamState
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
  state: StreamState
): void {
  if (op?.nodeId) {
    state.currentData.nodes = state.currentData.nodes.filter(
      (n) => n.id !== op.nodeId
    );
    state.currentData.edges = state.currentData.edges.filter(
      (e) => e.source !== op.nodeId && e.target !== op.nodeId
    );
  }
}

function handleRemoveEdge(
  op: StreamMessage["operation"],
  state: StreamState
): void {
  if (op?.edgeId) {
    state.currentData.edges = state.currentData.edges.filter(
      (e) => e.id !== op.edgeId
    );
  }
}

function handleUpdateNode(
  op: StreamMessage["operation"],
  state: StreamState
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
  state: StreamState
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
  state: StreamState
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
  }
}

function processStreamChunk(
  value: Uint8Array,
  decoder: TextDecoder,
  onUpdate: (data: WorkflowData) => void,
  state: StreamState
): void {
  state.buffer += decoder.decode(value, { stream: true });

  // Process complete JSONL lines
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() || "";

  for (const line of lines) {
    processStreamLine(line, onUpdate, state);
  }
}

export const aiApi = {
  generate: (
    prompt: string,
    existingWorkflow?: {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      name?: string;
    }
  ) =>
    apiCall<WorkflowData>("/api/ai/generate", {
      method: "POST",
      body: JSON.stringify({ prompt, existingWorkflow }),
    }),
  generateStream: async (
    prompt: string,
    onUpdate: (data: WorkflowData) => void,
    existingWorkflow?: {
      nodes: WorkflowNode[];
      edges: WorkflowEdge[];
      name?: string;
    }
  ): Promise<WorkflowData> => {
    const response = await fetch("/api/ai/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt, existingWorkflow }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
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
  },
};

export type Integration = {
  id: string;
  name: string;
  type: IntegrationType;
  isManaged?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type IntegrationWithConfig = Integration & {
  config: IntegrationConfig;
};

// Integration API
export const integrationApi = {
  // List all integrations
  getAll: (type?: IntegrationType) =>
    apiCall<Integration[]>(`/api/integrations${type ? `?type=${type}` : ""}`),

  // Get single integration with config
  get: (id: string) =>
    apiCall<IntegrationWithConfig>(`/api/integrations/${id}`),

  // Create integration
  create: (data: {
    name: string;
    type: IntegrationType;
    config: IntegrationConfig;
  }) =>
    apiCall<Integration>("/api/integrations", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Update integration
  update: (id: string, data: { name?: string; config?: IntegrationConfig }) =>
    apiCall<IntegrationWithConfig>(`/api/integrations/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  // Delete integration
  delete: (id: string) =>
    apiCall<{ success: boolean }>(`/api/integrations/${id}`, {
      method: "DELETE",
    }),

  // Test existing integration connection
  testConnection: (integrationId: string) =>
    apiCall<{ status: "success" | "error"; message: string }>(
      `/api/integrations/${integrationId}/test`,
      {
        method: "POST",
      }
    ),

  // Test credentials without saving
  testCredentials: (data: {
    type: IntegrationType;
    config: IntegrationConfig;
  }) =>
    apiCall<{ status: "success" | "error"; message: string }>(
      "/api/integrations/test",
      {
        method: "POST",
        body: JSON.stringify(data),
      }
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
      isAnonymous: boolean | null;
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
  getById: (id: string) => apiCall<SavedWorkflow>(`/api/workflows/${id}`),

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
      `/api/workflows/${id}/code`
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
      }
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
      debounce = true
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
export type DaprExecution = {
  id: string;
  workflowId: string;
  daprInstanceId: string;
  status: string;
  phase: string | null;
  progress: number | null;
  startedAt: string;
  completedAt: string | null;
};

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
  createdAt?: string;
  lastUpdatedAt?: string;
};

export type DaprWorkflowTask = {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  created_at?: string;
};

export const daprApi = {
  // List Dapr workflow executions
  listExecutions: () => apiCall<DaprExecution[]>("/api/dapr/workflows"),

  // Start a Dapr workflow
  startWorkflow: (
    workflowId: string,
    input: Record<string, unknown> = {}
  ) =>
    apiCall<{
      executionId: string;
      daprInstanceId: string;
      status: string;
    }>("/api/dapr/workflows", {
      method: "POST",
      body: JSON.stringify({ workflowId, input }),
    }),

  // Get Dapr workflow status
  getStatus: (executionId: string) =>
    apiCall<DaprWorkflowStatusResponse>(
      `/api/dapr/workflows/${executionId}/status`
    ),

  // Get tasks from Dapr statestore
  getTasks: (executionId: string) =>
    apiCall<DaprWorkflowTask[]>(
      `/api/dapr/workflows/${executionId}/tasks`
    ),

  // Approve or reject a Dapr workflow
  approve: (
    executionId: string,
    approved: boolean,
    reason?: string
  ) =>
    apiCall<{ success: boolean; message?: string }>(
      `/api/dapr/workflows/${executionId}/approve`,
      {
        method: "POST",
        body: JSON.stringify({ approved, reason }),
      }
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
    if (options?.executionType) params.set("executionType", options.executionType);
    if (options?.integrationType) params.set("integrationType", options.integrationType);
    if (options?.search) params.set("search", options.search);
    if (options?.includeDisabled) params.set("includeDisabled", "true");
    const queryString = params.toString();
    return apiCall<{ functions: FunctionSummary[] }>(
      `/api/functions${queryString ? `?${queryString}` : ""}`
    );
  },

  // Get a function by ID
  getById: (id: string) =>
    apiCall<FunctionDefinition>(`/api/functions/${id}`),

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
    }>
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

// Export all APIs as a single object
export const api = {
  ai: aiApi,
  dapr: daprApi,
  functions: functionsApi,
  integration: integrationApi,
  secrets: secretsApi,
  user: userApi,
  workflow: workflowApi,
};
