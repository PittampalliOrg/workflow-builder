/**
 * Builtin Handler
 *
 * Dispatches function execution to the statically compiled step registry.
 * This is the execution path for "builtin" execution type functions.
 */
import { getStepFunction, isActivityRegistered } from "../registry/step-registry.js";
import type { FunctionDefinition, WorkflowCredentials, ExecuteFunctionResult } from "../core/types.js";

/**
 * Input field normalization mappings
 * Maps legacy/alternative field names to the canonical field names expected by handlers
 * Format: { canonicalName: [alternatives...] }
 */
const INPUT_FIELD_MAPPINGS: Record<string, string[]> = {
  // OpenAI generate-text
  aiPrompt: ["prompt", "message", "text", "content"],
  aiModel: ["model"],
  aiFormat: ["format", "outputFormat"],
  aiSchema: ["schema"],
  // OpenAI generate-image
  imagePrompt: ["prompt", "description"],
  imageModel: ["model"],
  imageSize: ["size"],
  // Generic
  apiKey: ["api_key", "key"],
};

/**
 * Normalize input fields by mapping alternative names to canonical names
 */
function normalizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };

  for (const [canonical, alternatives] of Object.entries(INPUT_FIELD_MAPPINGS)) {
    // If canonical field already exists, skip
    if (normalized[canonical] !== undefined) {
      continue;
    }

    // Check if any alternative field exists
    for (const alt of alternatives) {
      if (normalized[alt] !== undefined) {
        normalized[canonical] = normalized[alt];
        console.log(`[Builtin Handler] Normalized input field: ${alt} -> ${canonical}`);
        break;
      }
    }
  }

  return normalized;
}

export interface BuiltinExecuteInput {
  fn: FunctionDefinition;
  input: Record<string, unknown>;
  credentials: WorkflowCredentials;
  context: {
    executionId: string;
    workflowId: string;
    nodeId: string;
    nodeName: string;
  };
}

/**
 * Execute a builtin function using the step registry
 */
export async function executeBuiltin(
  options: BuiltinExecuteInput
): Promise<ExecuteFunctionResult> {
  const { fn, input, credentials, context } = options;
  const startTime = Date.now();

  // Get step function from registry
  const stepFn = getStepFunction(fn.slug);

  if (!stepFn) {
    // If not found by slug, also check if activity is registered by any alias
    const isRegistered = isActivityRegistered(fn.slug);
    return {
      success: false,
      error: isRegistered
        ? `Step function found but could not be executed for: ${fn.slug}`
        : `Builtin step function not found in registry: ${fn.slug}`,
      duration_ms: Date.now() - startTime,
    };
  }

  try {
    console.log(`[Builtin Handler] Executing ${fn.slug} for node ${context.nodeName}`);

    // Normalize input fields (map legacy field names to canonical names)
    const normalizedInput = normalizeInput(input);

    // Prepare step input (merge config with context, credentials, and integration ID)
    // Credentials are injected directly so plugins don't need to fetch them again
    const stepInput = {
      ...normalizedInput,
      ...credentials, // Inject credentials directly (e.g., OPENAI_API_KEY)
      _credentials: credentials, // Also provide as separate object for plugins that need it
      _context: {
        executionId: context.executionId,
        nodeId: context.nodeId,
        nodeName: context.nodeName,
        nodeType: "function",
      },
    };

    // Execute the step
    const result = await stepFn(stepInput);
    const duration_ms = Date.now() - startTime;

    // Normalize the result
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
    console.error(`[Builtin Handler] Error executing ${fn.slug}:`, error);

    return {
      success: false,
      error: errorMessage,
      duration_ms,
    };
  }
}

/**
 * Check if a builtin function exists in the registry
 */
export function builtinExists(slug: string): boolean {
  return getStepFunction(slug) !== undefined;
}

/**
 * Get list of all available builtin functions
 */
export function listBuiltins(): string[] {
  const { getRegisteredActivityIds } = require("../registry/step-registry.js");
  return getRegisteredActivityIds();
}
