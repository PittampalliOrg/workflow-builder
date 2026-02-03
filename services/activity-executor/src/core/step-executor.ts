/**
 * Step Executor
 *
 * Executes plugin step handlers using a static registry.
 * This is the core of the activity executor service.
 *
 * Credentials are fetched from:
 * 1. Dapr secret store (auto-injection from Azure Key Vault)
 * 2. Database (user-configured integrations)
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
    // 1. Find the action definition (optional for system actions)
    const action = findActionById(input.activity_id);

    // 2. Check if step function exists in registry
    // This allows system actions (like HTTP Request) that don't have plugin definitions
    const stepFn = getStepFunction(input.activity_id);

    // If neither action definition nor step function exists, it's truly unknown
    if (!action && !stepFn) {
      return {
        success: false,
        error: `Unknown activity: ${input.activity_id}`,
        duration_ms: Date.now() - startTime,
      };
    }

    // 3. Fetch credentials (Dapr secrets + database fallback)
    // Extract integration type from activity ID (e.g., "slack/send-message" -> "slack")
    const integrationType = input.activity_id.split("/")[0];
    let credentials: WorkflowCredentials = {};

    // Fetch credentials: Dapr secrets take precedence, with DB fallback
    credentials = await fetchCredentials(input.integration_id, integrationType);

    // 4. Resolve template variables in the input config
    const resolvedInput = input.node_outputs
      ? resolveTemplates(input.input, input.node_outputs)
      : input.input;

    // 5. Ensure step function exists (should always be true after check above)
    if (!stepFn) {
      return {
        success: false,
        error: `Step function not found in registry for: ${input.activity_id}`,
        duration_ms: Date.now() - startTime,
      };
    }

    // 6. Prepare step input (merge config with context, credentials, and integration ID)
    // Credentials are injected directly so plugins don't need to fetch them again
    const stepInput = {
      ...resolvedInput,
      ...credentials,  // Inject credentials directly (e.g., OPENAI_API_KEY, AI_GATEWAY_API_KEY)
      integrationId: input.integration_id,
      _credentials: credentials,  // Also provide as separate object for plugins that need it
      _context: {
        executionId: input.execution_id,
        nodeId: input.node_id,
        nodeName: input.node_name,
        nodeType: "activity",
      },
    };

    // 7. Execute the step
    console.log(`[Step Executor] Executing ${input.activity_id} for node ${input.node_name}`);
    const result = await stepFn(stepInput);

    // 8. Normalize the result
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
