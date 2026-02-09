/**
 * Execute Action Activity
 *
 * This activity invokes the function-router service via Dapr service invocation
 * to route function execution to OpenFunctions (Knative serverless).
 *
 * The function-router supports:
 * - OpenFunctions: Scale-to-zero Knative services (fn-openai, fn-slack, etc.)
 * - Registry-based routing with wildcard and default fallback support
 */
import { DaprClient, HttpMethod } from "@dapr/dapr";
import {
  type NodeOutputs,
  resolveTemplates,
} from "../core/template-resolver.js";
import type { ActivityExecutionResult, SerializedNode } from "../core/types.js";

// Function router dispatches to OpenFunctions (Knative serverless)
// All function execution routes through function-router exclusively
const FUNCTION_ROUTER_APP_ID =
  process.env.FUNCTION_RUNNER_APP_ID || "function-router";

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

/**
 * Input for the execute action activity
 */
export type ExecuteActionInput = {
  node: SerializedNode;
  nodeOutputs: NodeOutputs;
  executionId: string;
  workflowId: string;
  integrations?: Record<string, Record<string, string>>;
  /** Database execution ID for logging (links to workflow_executions.id) */
  dbExecutionId?: string;
};

/**
 * Execute an action node by calling the function-router service
 *
 * Note: Dapr activities receive (ctx, input) but we don't need the ctx here
 */
export async function executeAction(
  _ctx: unknown,
  input: ExecuteActionInput
): Promise<ActivityExecutionResult> {
  const {
    node,
    nodeOutputs,
    executionId,
    workflowId,
    integrations,
    dbExecutionId,
  } = input;
  // Ensure config is never undefined to prevent runtime errors
  const config = (node.config || {}) as Record<string, unknown>;

  // Get actionType - the canonical identifier for functions
  // e.g., "openai/generate-text", "slack/send-message"
  const actionType = config.actionType as string | undefined;

  if (!actionType) {
    return {
      success: false,
      error: `No actionType specified for node ${node.id}. All action nodes must have an actionType configured.`,
      duration_ms: 0,
    };
  }

  // Use actionType as the function identifier
  const functionSlug = actionType;

  // Resolve template variables in the node config
  const resolvedConfig = resolveTemplates(config, nodeOutputs) as Record<
    string,
    unknown
  >;

  // Determine integration ID if available
  const integrationId = config.integrationId as string | undefined;

  // Build the request for function-router
  // Use node.label with fallback to functionSlug or node.id if empty
  const nodeName = node.label || functionSlug || node.id;

  // Build the request for function-router (routes to OpenFunctions)
  const request = {
    function_slug: functionSlug,
    execution_id: executionId,
    workflow_id: workflowId,
    node_id: node.id,
    node_name: nodeName,
    input: resolvedConfig,
    node_outputs: nodeOutputs,
    integration_id: integrationId,
    integrations, // Pass user's integrations for credential resolution
    db_execution_id: dbExecutionId, // Database execution ID for logging
  };

  const targetService = FUNCTION_ROUTER_APP_ID;

  console.log(`[Execute Action] Invoking function-router for ${functionSlug}`, {
    nodeId: node.id,
    nodeName,
  });

  const startTime = Date.now();

  try {
    // Create Dapr client for service invocation
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    // Invoke function-router via Dapr service invocation
    // Router dispatches to OpenFunctions or builtin handlers
    const response = await client.invoker.invoke(
      targetService,
      "execute",
      HttpMethod.POST,
      request
    );

    const duration_ms = Date.now() - startTime;

    // Parse response
    const result = response as ActivityExecutionResult;

    console.log(`[Execute Action] Function ${functionSlug} completed`, {
      success: result.success,
      duration_ms,
    });

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      duration_ms,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    console.error(
      `[Execute Action] Failed to invoke ${targetService} for ${functionSlug}:`,
      error
    );

    return {
      success: false,
      error: `Function execution failed: ${errorMessage}`,
      duration_ms,
    };
  }
}
