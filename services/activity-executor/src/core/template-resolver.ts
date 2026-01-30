/**
 * Template Resolver
 *
 * Wrapper around the template processing utilities from lib/utils/template.ts
 * Resolves template variables like {{@nodeId:Label.field}} in config values.
 */
import { processConfigTemplates, type NodeOutputs } from "@/lib/utils/template.js";

export type { NodeOutputs };

/**
 * Resolve all template variables in a configuration object
 *
 * @param config - Configuration object with potential template strings
 * @param nodeOutputs - Map of node outputs keyed by node ID
 * @returns Configuration object with templates resolved to actual values
 */
export function resolveTemplates(
  config: Record<string, unknown>,
  nodeOutputs: NodeOutputs
): Record<string, unknown> {
  return processConfigTemplates(config, nodeOutputs);
}
