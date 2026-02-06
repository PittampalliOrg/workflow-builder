/**
 * Template Resolver
 *
 * Resolves {{node.field}} template variables in workflow node configurations.
 * This allows nodes to reference outputs from previous nodes in the workflow.
 */

/**
 * Node outputs map: nodeId -> { label, data }
 */
export type NodeOutputs = Record<string, { label: string; data: unknown }>;

/**
 * Regular expression to match template variables: {{nodeId.field}} or {{nodeId.field.nested}}
 */
const TEMPLATE_REGEX = /\{\{([^}]+)\}\}/g;

/**
 * Get a nested value from an object using dot notation
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current === "object" && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Resolve a single template variable
 *
 * @param template The full template string (e.g., "{{node1.output.message}}")
 * @param nodeOutputs Map of node outputs
 * @returns The resolved value or the original template if not found
 */
function resolveTemplate(
  template: string,
  nodeOutputs: NodeOutputs
): unknown {
  // Extract the path from the template (remove {{ and }})
  const path = template.slice(2, -2).trim();
  const parts = path.split(".");

  if (parts.length < 2) {
    return template; // Invalid template, return as-is
  }

  const nodeId = parts[0];
  const fieldPath = parts.slice(1).join(".");

  const nodeOutput = nodeOutputs[nodeId];
  if (!nodeOutput) {
    // Try to find by label
    const byLabel = Object.values(nodeOutputs).find(
      (o) => o.label.toLowerCase().replace(/\s+/g, "_") === nodeId.toLowerCase()
    );
    if (!byLabel) {
      return template; // Node not found, return original template
    }
    return getNestedValue(byLabel.data, fieldPath) ?? template;
  }

  const value = getNestedValue(nodeOutput.data, fieldPath);
  return value !== undefined ? value : template;
}

/**
 * Resolve all template variables in a string
 *
 * @param str The string containing templates
 * @param nodeOutputs Map of node outputs
 * @returns The string with all templates resolved
 */
function resolveStringTemplates(
  str: string,
  nodeOutputs: NodeOutputs
): string {
  // Check if the entire string is a single template
  const singleTemplateMatch = str.match(/^\{\{([^}]+)\}\}$/);
  if (singleTemplateMatch) {
    const resolved = resolveTemplate(str, nodeOutputs);
    // If resolved to a non-string value, convert to string for this context
    return String(resolved);
  }

  // Replace all templates in the string
  return str.replace(TEMPLATE_REGEX, (match) => {
    const resolved = resolveTemplate(match, nodeOutputs);
    return String(resolved);
  });
}

/**
 * Recursively resolve templates in an object or array
 *
 * @param value The value to resolve templates in
 * @param nodeOutputs Map of node outputs
 * @returns The value with all templates resolved
 */
export function resolveTemplates(
  value: unknown,
  nodeOutputs: NodeOutputs
): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    // Check if entire string is a template - return the actual type
    const singleTemplateMatch = value.match(/^\{\{([^}]+)\}\}$/);
    if (singleTemplateMatch) {
      return resolveTemplate(value, nodeOutputs);
    }
    // Otherwise, do string replacement
    return resolveStringTemplates(value, nodeOutputs);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, nodeOutputs));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = resolveTemplates(val, nodeOutputs);
    }
    return result;
  }

  // Primitives (number, boolean, etc.) pass through unchanged
  return value;
}

/**
 * Check if a string contains template variables
 */
export function containsTemplates(str: string): boolean {
  return TEMPLATE_REGEX.test(str);
}
