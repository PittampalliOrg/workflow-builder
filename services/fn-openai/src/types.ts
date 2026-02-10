/**
 * Type definitions for fn-openai OpenFunction
 */

/**
 * Node output from upstream nodes
 */
export type NodeOutput = {
  label: string;
  data: unknown;
};

export type NodeOutputs = Record<string, NodeOutput>;

/**
 * Execute request from function-router
 */
export type ExecuteRequest = {
  step: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  input: Record<string, unknown>;
  node_outputs?: NodeOutputs;
  credentials?: Record<string, string>;
};

/**
 * Execute response
 */
export type ExecuteResponse = {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
};

/**
 * OpenAI credentials
 */
export type OpenAICredentials = {
  OPENAI_API_KEY?: string;
};
