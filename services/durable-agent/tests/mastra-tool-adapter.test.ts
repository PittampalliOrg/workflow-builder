/**
 * Tests for Mastra tool adapter.
 */
import { describe, it, expect } from "vitest";
import {
  adaptMastraTool,
  adaptMastraTools,
  type MastraToolLike,
} from "../src/mastra/tool-adapter.js";

describe("adaptMastraTool", () => {
  it("should convert a Mastra tool to DurableAgentTool", async () => {
    const mastraTool: MastraToolLike = {
      id: "get-weather",
      description: "Get current weather",
      inputSchema: { type: "object", properties: { location: { type: "string" } } },
      execute: async (input) => ({ temperature: 72, location: input.location }),
    };

    const adapted = adaptMastraTool(mastraTool);

    expect(adapted.description).toBe("Get current weather");
    expect(adapted.inputSchema).toEqual({
      type: "object",
      properties: { location: { type: "string" } },
    });

    const result = await adapted.execute({ location: "NYC" });
    expect(result).toEqual({ temperature: 72, location: "NYC" });
  });

  it("should strip the context parameter", async () => {
    let receivedContext: unknown = "NOT_CALLED";
    const mastraTool: MastraToolLike = {
      id: "ctx-tool",
      execute: async (_input, context) => {
        receivedContext = context;
        return "ok";
      },
    };

    const adapted = adaptMastraTool(mastraTool);
    await adapted.execute({ foo: "bar" });

    // The adapter calls execute(args) without a second argument,
    // so context should be undefined
    expect(receivedContext).toBeUndefined();
  });

  it("should handle tools without description or schema", async () => {
    const mastraTool: MastraToolLike = {
      id: "minimal",
      execute: async () => "done",
    };

    const adapted = adaptMastraTool(mastraTool);
    expect(adapted.description).toBeUndefined();
    expect(adapted.inputSchema).toBeUndefined();

    const result = await adapted.execute({});
    expect(result).toBe("done");
  });
});

describe("adaptMastraTools", () => {
  it("should convert a record of Mastra tools", async () => {
    const tools: Record<string, MastraToolLike> = {
      "tool-a": {
        id: "tool-a",
        description: "Tool A",
        execute: async () => "a",
      },
      "tool-b": {
        id: "tool-b",
        description: "Tool B",
        execute: async () => "b",
      },
    };

    const adapted = adaptMastraTools(tools);

    expect(Object.keys(adapted)).toHaveLength(2);
    expect(adapted["tool-a"].description).toBe("Tool A");
    expect(adapted["tool-b"].description).toBe("Tool B");
    expect(await adapted["tool-a"].execute({})).toBe("a");
    expect(await adapted["tool-b"].execute({})).toBe("b");
  });

  it("should handle empty record", () => {
    const adapted = adaptMastraTools({});
    expect(Object.keys(adapted)).toHaveLength(0);
  });
});
