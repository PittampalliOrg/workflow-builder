/**
 * Execute Action Activity
 *
 * This activity invokes the function-runner service via Dapr service invocation
 * to execute plugin step handlers (Slack, GitHub, AI, etc.).
 *
 * The function-runner supports three execution types:
 * - builtin: Statically compiled TypeScript handlers
 * - oci: Container images executed as Kubernetes Jobs
 * - http: External HTTP webhooks
 */
import { DaprClient, HttpMethod } from "@dapr/dapr";
import type {
  ActivityExecutionRequest,
  ActivityExecutionResult,
  SerializedNode,
} from "../core/types.js";
import { resolveTemplates, type NodeOutputs } from "../core/template-resolver.js";

// Function runner is the new service that replaces activity-executor
// It supports builtin, OCI, and HTTP function execution
const FUNCTION_RUNNER_APP_ID =
  process.env.FUNCTION_RUNNER_APP_ID || "function-runner";

// Legacy activity-executor support (fallback)
const ACTIVITY_EXECUTOR_APP_ID =
  process.env.ACTIVITY_EXECUTOR_APP_ID || "activity-executor";

// Determine which service to use (default to function-runner)
const USE_FUNCTION_RUNNER = process.env.USE_FUNCTION_RUNNER !== "false";

const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";

/**
 * Input for the execute action activity
 */
export interface ExecuteActionInput {
  node: SerializedNode;
  nodeOutputs: NodeOutputs;
  executionId: string;
  workflowId: string;
  integrations?: Record<string, Record<string, string>>;
}

/**
 * Execute an action node by calling the activity-executor service
 *
 * Note: Dapr activities receive (ctx, input) but we don't need the ctx here
 */
export async function executeAction(
  _ctx: unknown,
  input: ExecuteActionInput
): Promise<ActivityExecutionResult> {
  const { node, nodeOutputs, executionId, workflowId, integrations } = input;
  const config = node.config as Record<string, unknown>;

  // Determine the activity ID
  // Check multiple config fields for backwards compatibility
  const activityId =
    (config.actionId as string) ||
    (config.activityName as string) ||
    (config.actionType as string) ||
    node.label;

  if (!activityId) {
    return {
      success: false,
      error: `No actionId, activityName, or actionType specified for node ${node.id}`,
      duration_ms: 0,
    };
  }

  // Resolve template variables in the node config
  const resolvedConfig = resolveTemplates(config, nodeOutputs) as Record<
    string,
    unknown
  >;

  // Determine integration ID if available
  const integrationId = config.integrationId as string | undefined;

  // Build the request for function-runner (or activity-executor for legacy)
  // Use node.label with fallback to activityId or node.id if empty
  const nodeName = node.label || activityId || node.id;

  // Function runner request format
  const functionRunnerRequest = {
    function_slug: activityId,
    execution_id: executionId,
    workflow_id: workflowId,
    node_id: node.id,
    node_name: nodeName,
    input: resolvedConfig,
    node_outputs: nodeOutputs,
    integration_id: integrationId,
  };

  // Legacy activity-executor request format (for fallback)
  const activityExecutorRequest: ActivityExecutionRequest = {
    activity_id: activityId,
    execution_id: executionId,
    workflow_id: workflowId,
    node_id: node.id,
    node_name: nodeName,
    input: resolvedConfig,
    node_outputs: nodeOutputs,
    integration_id: integrationId,
  };

  const targetService = USE_FUNCTION_RUNNER
    ? FUNCTION_RUNNER_APP_ID
    : ACTIVITY_EXECUTOR_APP_ID;
  const request = USE_FUNCTION_RUNNER
    ? functionRunnerRequest
    : activityExecutorRequest;

  console.log(
    `[Execute Action] Invoking ${targetService} for ${activityId}`,
    { nodeId: node.id, nodeName, useFunctionRunner: USE_FUNCTION_RUNNER }
  );

  const startTime = Date.now();

  try {
    // Create Dapr client for service invocation
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    // Invoke function-runner (or activity-executor) via Dapr service invocation
    const response = await client.invoker.invoke(
      targetService,
      "execute",
      HttpMethod.POST,
      request
    );

    const duration_ms = Date.now() - startTime;

    // Parse response
    const result = response as ActivityExecutionResult;

    console.log(
      `[Execute Action] Activity ${activityId} completed`,
      { success: result.success, duration_ms }
    );

    return {
      success: result.success,
      data: result.data,
      error: result.error,
      duration_ms,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errorMessage =
      error instanceof Error ? error.message : String(error);

    console.error(
      `[Execute Action] Failed to invoke ${targetService} for ${activityId}:`,
      error
    );

    return {
      success: false,
      error: `Activity execution failed: ${errorMessage}`,
      duration_ms,
    };
  }
}
