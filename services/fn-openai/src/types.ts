/**
 * Type definitions for fn-openai OpenFunction
 */

/**
 * Node output from upstream nodes
 */
export interface NodeOutput {
  label: string;
  data: unknown;
}

export type NodeOutputs = Record<string, NodeOutput>;

/**
 * Execute request from function-router
 */
export interface ExecuteRequest {
  step: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  input: Record<string, unknown>;
  node_outputs?: NodeOutputs;
  credentials?: Record<string, string>;
}

/**
 * Execute response
 */
export interface ExecuteResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
}

/**
 * OpenAI credentials
 */
export interface OpenAICredentials {
  OPENAI_API_KEY?: string;
}
