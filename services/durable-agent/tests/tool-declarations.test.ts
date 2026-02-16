/**
 * Tests for tool declaration building.
 */
import { describe, it, expect } from "vitest";
import { buildToolDeclarations } from "../src/llm/tool-declarations.js";
import type { DurableAgentTool } from "../src/types/tool.js";

describe("buildToolDeclarations", () => {
  it("should build declarations from tools", () => {
    const tools: Record<string, DurableAgentTool> = {
      "get-weather": {
        description: "Get current weather",
        inputSchema: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
        execute: async () => ({ temperature: 72 }),
      },
    };

    const decls = buildToolDeclarations(tools);
    expect(Object.keys(decls)).toHaveLength(1);
    expect(decls["get-weather"].description).toBe("Get current weather");
    expect(decls["get-weather"].parameters).toEqual({
      type: "object",
      properties: { location: { type: "string" } },
      required: ["location"],
    });
  });

  it("should handle empty tools", () => {
    const decls = buildToolDeclarations({});
    expect(Object.keys(decls)).toHaveLength(0);
  });

  it("should handle tools without description", () => {
    const tools: Record<string, DurableAgentTool> = {
      "my-tool": {
        inputSchema: { type: "object" },
        execute: async () => "result",
      },
    };

    const decls = buildToolDeclarations(tools);
    expect(decls["my-tool"].description).toBe("");
  });

  it("should handle multiple tools", () => {
    const tools: Record<string, DurableAgentTool> = {
      "tool-a": {
        description: "Tool A",
        inputSchema: { type: "object" },
        execute: async () => "a",
      },
      "tool-b": {
        description: "Tool B",
        inputSchema: { type: "object" },
        execute: async () => "b",
      },
      "tool-c": {
        description: "Tool C",
        inputSchema: { type: "object" },
        execute: async () => "c",
      },
    };

    const decls = buildToolDeclarations(tools);
    expect(Object.keys(decls)).toHaveLength(3);
    expect(decls["tool-a"].description).toBe("Tool A");
    expect(decls["tool-b"].description).toBe("Tool B");
    expect(decls["tool-c"].description).toBe("Tool C");
  });
});
