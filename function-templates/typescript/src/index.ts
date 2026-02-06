/**
 * Custom Function Template (TypeScript)
 *
 * This is a template for creating custom functions that can be executed
 * as OCI containers by the function-runner service.
 *
 * Input:
 *   - Received via INPUT environment variable (JSON string)
 *   - Additional context available via EXECUTION_ID, WORKFLOW_ID, NODE_ID, NODE_NAME
 *   - Credentials injected as environment variables (e.g., API_KEY)
 *
 * Output:
 *   - Write JSON to stdout (the function-runner captures this)
 *   - Use console.error for logs (not captured as output)
 *
 * Example:
 *   INPUT='{"name":"World"}' node dist/index.js
 *   => {"success":true,"result":"Hello, World!"}
 */
import { z } from "zod";

// ============================================================================
// CUSTOMIZE THESE TYPES AND SCHEMAS FOR YOUR FUNCTION
// ============================================================================

/**
 * Input schema - define what your function expects
 */
const InputSchema = z.object({
  name: z.string().default("World"),
  count: z.number().optional().default(1),
});

type Input = z.infer<typeof InputSchema>;

/**
 * Output type - define what your function returns
 */
interface Output {
  success: boolean;
  result?: string;
  error?: string;
}

// ============================================================================
// MAIN FUNCTION LOGIC
// ============================================================================

/**
 * Your main function logic goes here
 */
async function execute(input: Input): Promise<Output> {
  try {
    // Your custom logic here
    const messages: string[] = [];
    for (let i = 0; i < input.count; i++) {
      messages.push(`Hello, ${input.name}!`);
    }

    return {
      success: true,
      result: messages.join("\n"),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// RUNNER (DO NOT MODIFY BELOW)
// ============================================================================

async function main() {
  // Parse input from environment variable
  const inputJson = process.env.INPUT || "{}";

  // Log context for debugging (goes to stderr, not captured as output)
  console.error(`[Function] Execution ID: ${process.env.EXECUTION_ID || "unknown"}`);
  console.error(`[Function] Workflow ID: ${process.env.WORKFLOW_ID || "unknown"}`);
  console.error(`[Function] Node ID: ${process.env.NODE_ID || "unknown"}`);

  try {
    // Parse and validate input
    const rawInput = JSON.parse(inputJson);
    const input = InputSchema.parse(rawInput);

    console.error(`[Function] Input:`, JSON.stringify(input));

    // Execute the function
    const output = await execute(input);

    // Write output to stdout (this is captured by function-runner)
    console.log(JSON.stringify(output));

    // Exit with appropriate code
    process.exit(output.success ? 0 : 1);
  } catch (error) {
    // Handle parsing/validation errors
    const output: Output = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };

    console.log(JSON.stringify(output));
    process.exit(1);
  }
}

main();
