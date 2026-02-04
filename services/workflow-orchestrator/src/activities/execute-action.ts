/**
 * Execute Action Activity
 *
 * This activity invokes the activity-executor service via Dapr service invocation
 * to execute plugin step handlers (Slack, GitHub, AI, etc.).
 */
import { DaprClient, HttpMethod } from "@dapr/dapr";
import type {
  ActivityExecutionRequest,
  ActivityExecutionResult,
  SerializedNode,
} from "../core/types.js";
import { resolveTemplates, type NodeOutputs } from "../core/template-resolver.js";

const ACTIVITY_EXECUTOR_APP_ID =
  process.env.ACTIVITY_EXECUTOR_APP_ID || "activity-executor";
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

  // Build the request for activity-executor
  // Use node.label with fallback to activityId or node.id if empty
  const nodeName = node.label || activityId || node.id;

  const request: ActivityExecutionRequest = {
    activity_id: activityId,
    execution_id: executionId,
    workflow_id: workflowId,
    node_id: node.id,
    node_name: nodeName,
    input: resolvedConfig,
    node_outputs: nodeOutputs,
    integration_id: integrationId,
  };

  console.log(
    `[Execute Action] Invoking activity-executor for ${activityId}`,
    { nodeId: node.id, nodeName }
  );

  const startTime = Date.now();

  try {
    // Create Dapr client for service invocation
    const client = new DaprClient({
      daprHost: DAPR_HOST,
      daprPort: DAPR_HTTP_PORT,
    });

    // Invoke activity-executor via Dapr service invocation
    const response = await client.invoker.invoke(
      ACTIVITY_EXECUTOR_APP_ID,
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
      `[Execute Action] Failed to invoke activity-executor for ${activityId}:`,
      error
    );

    return {
      success: false,
      error: `Activity execution failed: ${errorMessage}`,
      duration_ms,
    };
  }
}
