/** Outbound boundary for workspace-scoped workflow execution diagnostics. */

export type WorkflowExecutionStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled";

export type WorkflowExecutionListQuery = {
  workflowId?: string;
  workflowName?: string;
  status?: WorkflowExecutionStatus;
  limit?: number;
  cursor?: string;
};

export type TraceSpanQuery = {
  query?: string;
  errorsOnly?: boolean;
  service?: string;
  limit?: number;
  cursor?: string;
};

export type TraceToolCallQuery = {
  spanId?: string;
  sessionId?: string;
  toolName?: string;
  errorsOnly?: boolean;
  limit?: number;
  cursor?: string;
};

export type TraceLlmTurnQuery = {
  spanId?: string;
  sessionId?: string;
  limit?: number;
  cursor?: string;
};

export type TraceLogQuery = {
  spanId?: string;
  query?: string;
  errorsOnly?: boolean;
  limit?: number;
  cursor?: string;
};

export interface WorkflowDiagnosticsPort {
  listWorkflowExecutions(query: WorkflowExecutionListQuery): Promise<unknown>;
  getExecutionOverview(executionId: string): Promise<unknown>;
  getDigest(executionId: string): Promise<unknown>;
  searchSpans(executionId: string, query: TraceSpanQuery): Promise<unknown>;
  getSpan(executionId: string, spanId: string): Promise<unknown>;
  getLlmTurns(executionId: string, query: TraceLlmTurnQuery): Promise<unknown>;
  getToolCalls(executionId: string, query: TraceToolCallQuery): Promise<unknown>;
  getSpanTree(executionId: string, maxNodes?: number): Promise<unknown>;
  searchLogs(executionId: string, query: TraceLogQuery): Promise<unknown>;
  getBrowserScreenshot(executionId: string, storageRef: string): Promise<unknown>;
}
