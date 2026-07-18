/** Read-only persistence boundary required by the workflow MCP tool surface. */

export type WorkflowSummary = {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  engineType: string | null;
  specVersion: string | null;
  created_at: string;
  updated_at: string;
  node_count: number;
  edge_count: number;
};

export type WorkflowRecord = {
  id: string;
  name: string;
  description: string | null;
  nodes: unknown[];
  edges: unknown[];
  visibility: string;
  engineType?: string | null;
  specVersion?: string | null;
  spec?: unknown;
  created_at: string;
  updated_at: string;
};

export type WorkflowAction = {
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  source: "builtin" | "piece";
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: string;
  phase: string | null;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  duration: string | null;
};

export type WorkflowExecutionLog = {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  actionType: string | null;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  duration: string | null;
};

export interface WorkflowPersistencePort {
  listWorkflows(projectId: string, limit?: number): Promise<WorkflowSummary[]>;
  findWorkflow(ref: string, projectId: string): Promise<WorkflowRecord | null>;
  listAvailableActions(search?: string): Promise<WorkflowAction[]>;
  findExecution(
    ref: string,
    projectId: string,
  ): Promise<WorkflowExecution | null>;
  listExecutionLogs(executionId: string): Promise<WorkflowExecutionLog[]>;
}

export interface ScriptWorkflowPersistencePort {
  findWorkflow(
    ref: string,
    projectId: string,
  ): Promise<Pick<WorkflowRecord, "id" | "engineType"> | null>;
}
