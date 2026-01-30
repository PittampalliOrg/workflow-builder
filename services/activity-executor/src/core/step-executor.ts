/**
 * Step Executor
 *
 * Executes plugin step handlers using a static registry.
 * This is the core of the activity executor service.
 */
import { findActionById } from "@/plugins/registry.js";
import { fetchCredentials, type WorkflowCredentials } from "./credential-service.js";
import { resolveTemplates, type NodeOutputs } from "./template-resolver.js";
import { getStepFunction, isActivityRegistered } from "./step-registry.js";

export type StepExecutionInput = {
  activity_id: string;           // e.g., "slack/send-message"
  execution_id: string;          // For logging correlation
  workflow_id: string;           // Dapr workflow instance ID
  node_id: string;               // Node ID in workflow graph
  node_name: string;             // Human-readable name
  input: Record<string, unknown>;// Config values (may contain templates)
  node_outputs?: NodeOutputs;    // For template resolution
  integration_id?: string;       // ID to fetch credentials
};

export type StepExecutionResult = {
  success: boolean;
  data?: unknown;
  error?: string;
  duration_ms: number;
};

/**
 * Execute a step handler for the given activity
 */
export async function executeStep(
  input: StepExecutionInput
): Promise<StepExecutionResult> {
  const startTime = Date.now();

  try {
    // 1. Find the action definition
    const action = findActionById(input.activity_id);
    if (!action) {
      return {
        success: false,
        error: `Unknown activity: ${input.activity_id}`,
        duration_ms: Date.now() - startTime,
      };
    }

    // 2. Fetch credentials if integration_id is provided
    let credentials: WorkflowCredentials = {};
    if (input.integration_id) {
      credentials = await fetchCredentials(input.integration_id);
    }

    // 3. Resolve template variables in the input config
    const resolvedInput = input.node_outputs
      ? resolveTemplates(input.input, input.node_outputs)
      : input.input;

    // 4. Get step function from static registry
    const stepFn = getStepFunction(input.activity_id);

    if (!stepFn) {
      return {
        success: false,
        error: `Step function not found in registry for: ${input.activity_id}`,
        duration_ms: Date.now() - startTime,
      };
    }

    // 5. Prepare step input (merge config with context and integration ID)
    const stepInput = {
      ...resolvedInput,
      integrationId: input.integration_id,
      _context: {
        executionId: input.execution_id,
        nodeId: input.node_id,
        nodeName: input.node_name,
        nodeType: "activity",
      },
    };

    // 6. Execute the step
    console.log(`[Step Executor] Executing ${input.activity_id} for node ${input.node_name}`);
    const result = await stepFn(stepInput);

    // 7. Normalize the result
    const duration_ms = Date.now() - startTime;

    if (result && typeof result === "object" && "success" in result) {
      const typedResult = result as { success: boolean; error?: string };
      if (typedResult.success === false) {
        return {
          success: false,
          error: typedResult.error || "Step execution failed",
          data: result,
          duration_ms,
        };
      }
      return {
        success: true,
        data: result,
        duration_ms,
      };
    }

    // Legacy result format (no success field)
    return {
      success: true,
      data: result,
      duration_ms,
    };
  } catch (error) {
    const duration_ms = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[Step Executor] Error executing ${input.activity_id}:`, error);

    return {
      success: false,
      error: errorMessage,
      duration_ms,
    };
  }
}

/**
 * Get list of all available activities
 * Useful for discovery/introspection
 */
export async function listAvailableActivities(): Promise<Array<{
  id: string;
  label: string;
  description: string;
  integration: string;
}>> {
  const { getAllActions } = await import("@/plugins/registry.js");
  const actions = getAllActions();

  return actions.map((action) => ({
    id: action.id,
    label: action.label,
    description: action.description,
    integration: action.integration,
  }));
}
