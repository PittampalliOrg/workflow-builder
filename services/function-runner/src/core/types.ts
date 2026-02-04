/**
 * Core Types for Function Runner Service
 *
 * These types define the data structures used by the function runner
 * for function execution, persistence, and inter-service communication.
 */

/**
 * Execution types for functions
 */
export type FunctionExecutionType = "builtin" | "oci" | "http";

/**
 * Function execution status
 */
export type FunctionExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

/**
 * Retry policy configuration
 */
export interface RetryPolicy {
  maxAttempts?: number;
  initialDelaySeconds?: number;
  maxDelaySeconds?: number;
  backoffMultiplier?: number;
}

/**
 * Function definition from the database
 */
export interface FunctionDefinition {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  pluginId: string;
  version: string;
  executionType: FunctionExecutionType;

  // OCI container config
  imageRef: string | null;
  command: string | null;
  workingDir: string | null;
  containerEnv: Record<string, string> | null;

  // HTTP webhook config
  webhookUrl: string | null;
  webhookMethod: string | null;
  webhookHeaders: Record<string, string> | null;
  webhookTimeoutSeconds: number | null;

  // Schema
  inputSchema: unknown;
  outputSchema: unknown;

  // Execution config
  timeoutSeconds: number | null;
  retryPolicy: RetryPolicy | null;
  maxConcurrency: number | null;
  integrationType: string | null;

  // Flags
  isBuiltin: boolean | null;
  isEnabled: boolean | null;
  isDeprecated: boolean | null;
}

/**
 * Request to execute a function
 */
export interface ExecuteFunctionRequest {
  // One of these is required
  function_id?: string;
  function_slug?: string;

  // Execution context
  workflow_id: string;
  execution_id: string;
  node_id: string;
  node_name: string;

  // Input configuration
  input: Record<string, unknown>;
  node_outputs?: NodeOutputs;
  integration_id?: string;
}

/**
 * Result from function execution
 */
export interface ExecuteFunctionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;

  // For OCI functions
  job_name?: string;
  pod_name?: string;
}

/**
 * Node outputs for template resolution
 */
export interface NodeOutputs {
  [nodeId: string]: {
    label: string;
    data: unknown;
  };
}

/**
 * Credentials for integration
 */
export type WorkflowCredentials = Record<string, string | undefined>;

/**
 * OCI Job execution options
 */
export interface OciJobOptions {
  imageRef: string;
  command?: string;
  workingDir?: string;
  containerEnv?: Record<string, string>;
  timeoutSeconds?: number;
  namespace?: string;
}

/**
 * OCI Job execution result
 */
export interface OciJobResult {
  success: boolean;
  output?: unknown;
  error?: string;
  jobName: string;
  podName?: string;
  exitCode?: number;
}

/**
 * HTTP webhook execution options
 */
export interface HttpWebhookOptions {
  url: string;
  method: string;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
}

/**
 * HTTP webhook execution result
 */
export interface HttpWebhookResult {
  success: boolean;
  data?: unknown;
  error?: string;
  statusCode?: number;
}
