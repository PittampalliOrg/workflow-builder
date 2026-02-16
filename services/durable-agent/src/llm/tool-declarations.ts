/**
 * Build schema-only tool declarations for the LLM.
 * Tools are declared but NOT auto-executed — the workflow orchestrator
 * handles tool execution as separate activities.
 */

import type { DurableAgentTool } from "../types/tool.js";

/**
 * Build AI SDK tool declarations (schema-only, no execute).
 * This lets the LLM know which tools are available without
 * the SDK auto-executing them.
 */
export function buildToolDeclarations(
  tools: Record<string, DurableAgentTool>,
): Record<string, { description: string; parameters: unknown }> {
  const decls: Record<string, { description: string; parameters: unknown }> =
    {};
  for (const [name, tool] of Object.entries(tools)) {
    decls[name] = {
      description: tool.description ?? "",
      parameters: tool.inputSchema,
    };
  }
  return decls;
}
