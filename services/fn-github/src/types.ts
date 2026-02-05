/**
 * Type definitions for fn-github OpenFunction
 */

export interface NodeOutput {
  label: string;
  data: unknown;
}

export type NodeOutputs = Record<string, NodeOutput>;

export interface ExecuteRequest {
  step: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  input: Record<string, unknown>;
  node_outputs?: NodeOutputs;
  credentials?: Record<string, string>;
}

export interface ExecuteResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
}

export interface GitHubCredentials {
  GITHUB_TOKEN?: string;
}
