/**
 * Mastra Tool Adapter — converts Mastra createTool() objects to DurableAgentTool.
 *
 * Uses inline interface to avoid compile-time @mastra/core dependency.
 * Strips the `context` param that Mastra tools expect but durable-agent doesn't use.
 */

import type { DurableAgentTool } from "../types/tool.js";

/**
 * Structural interface matching a Mastra createTool() object.
 * Avoids importing from @mastra/core at compile time.
 */
export interface MastraToolLike {
  id: string;
  description?: string;
  inputSchema?: unknown;
  execute: (
    inputData: Record<string, unknown>,
    context?: unknown,
  ) => Promise<unknown>;
}

/**
 * Convert a single Mastra tool to a DurableAgentTool.
 * Strips the second `context` parameter from execute().
 */
export function adaptMastraTool(tool: MastraToolLike): DurableAgentTool {
  return {
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: (args: Record<string, unknown>) => tool.execute(args),
  };
}

/**
 * Convert a record of Mastra tools to DurableAgentTool record.
 * Keys are preserved from the input record.
 */
export function adaptMastraTools(
  tools: Record<string, MastraToolLike>,
): Record<string, DurableAgentTool> {
  const adapted: Record<string, DurableAgentTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    adapted[name] = adaptMastraTool(tool);
  }
  return adapted;
}
