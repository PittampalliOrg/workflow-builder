/**
 * Type definitions for fn-stripe OpenFunction
 */

export type NodeOutput = {
  label: string;
  data: unknown;
};

export type NodeOutputs = Record<string, NodeOutput>;

export type ExecuteRequest = {
  step: string;
  execution_id: string;
  workflow_id: string;
  node_id: string;
  input: Record<string, unknown>;
  node_outputs?: NodeOutputs;
  credentials?: Record<string, string>;
};

export type ExecuteResponse = {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
};

export type StripeCredentials = {
  STRIPE_SECRET_KEY?: string;
};
