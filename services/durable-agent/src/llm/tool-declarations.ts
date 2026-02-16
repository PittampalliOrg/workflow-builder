/**
 * Build schema-only tool declarations for the LLM.
 * Tools are declared but NOT auto-executed — the workflow orchestrator
 * handles tool execution as separate activities.
 */

import { tool, jsonSchema } from "ai";
import type { DurableAgentTool } from "../types/tool.js";

/**
 * Build AI SDK 6 tool declarations (schema-only, no execute).
 * Uses tool() with inputSchema so the LLM knows which tools
 * are available without the SDK auto-executing them.
 */
export function buildToolDeclarations(
  tools: Record<string, DurableAgentTool>,
): Record<string, any> {
  const decls: Record<string, any> = {};
  for (const [name, t] of Object.entries(tools)) {
    const schema = t.inputSchema;
    const jsonSch = schema
      ? jsonSchema(zodToJsonSchema(schema) as any)
      : undefined;

    decls[name] = tool({
      description: t.description ?? "",
      inputSchema: jsonSch ?? jsonSchema({ type: "object" } as any),
    });
  }
  return decls;
}

/**
 * Minimal Zod → JSON Schema conversion for tool input schemas.
 * Handles the common types used by workspace tools.
 */
function zodToJsonSchema(schema: any): Record<string, unknown> {
  if (!schema) {
    return { type: "object" };
  }

  // Already a plain JSON Schema object (not a Zod schema) — pass through
  if (!schema._def && typeof schema.type === "string") {
    return schema;
  }

  if (!schema._def) {
    return { type: "object" };
  }

  const def = schema._def;
  const typeName = def.typeName;

  if (typeName === "ZodObject") {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const shape = schema.shape ?? def.shape?.() ?? {};

    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value as any);
      if ((value as any)?._def?.typeName !== "ZodOptional") {
        required.push(key);
      }
    }

    return {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  if (typeName === "ZodString") return { type: "string" };
  if (typeName === "ZodNumber") return { type: "number" };
  if (typeName === "ZodBoolean") return { type: "boolean" };
  if (typeName === "ZodOptional") return zodToJsonSchema(def.innerType);
  if (typeName === "ZodDefault") return zodToJsonSchema(def.innerType);
  if (typeName === "ZodArray") {
    return { type: "array", items: zodToJsonSchema(def.type) };
  }
  if (typeName === "ZodEnum") {
    return { type: "string", enum: def.values };
  }

  return { type: "string" };
}
