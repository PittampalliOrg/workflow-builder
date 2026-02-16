/**
 * Tests for message format conversion (AgentWorkflowMessage <-> AI SDK CoreMessage).
 */
import { describe, it, expect } from "vitest";
import { toAiSdkMessages } from "../src/llm/message-converter.js";
import type { AgentWorkflowMessage } from "../src/types/state.js";

describe("toAiSdkMessages", () => {
  it("should convert user messages", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "user",
        content: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("should convert simple assistant messages", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Hi there!",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "assistant", content: "Hi there!" });
  });

  it("should convert assistant messages with tool calls", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: "Let me check the weather.",
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: {
              name: "get-weather",
              arguments: '{"location":"NYC"}',
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    expect(result).toHaveLength(1);

    const msg = result[0];
    expect(msg.role).toBe("assistant");
    // Content should be an array with text + tool-call parts
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<Record<string, unknown>>;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: "text", text: "Let me check the weather." });
    expect(parts[1]).toEqual({
      type: "tool-call",
      toolCallId: "tc-1",
      toolName: "get-weather",
      args: { location: "NYC" },
    });
  });

  it("should convert assistant tool calls without text content", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: {
              name: "get-weather",
              arguments: '{"location":"NYC"}',
            },
          },
        ],
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    const parts = result[0].content as Array<Record<string, unknown>>;
    // Should only have tool-call part (no text part since content was null)
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("tool-call");
  });

  it("should convert tool result messages", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "tool",
        content: '{"temperature":72}',
        tool_call_id: "tc-1",
        name: "get-weather",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("tool");
    const toolContent = (result[0] as any).content;
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]).toEqual({
      type: "tool-result",
      toolCallId: "tc-1",
      toolName: "get-weather",
      result: '{"temperature":72}',
    });
  });

  it("should filter out system messages", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "system",
        content: "You are a helpful assistant.",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "2",
        role: "user",
        content: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    // System messages should be filtered out
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("should handle a full conversation round-trip", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "user",
        content: "What's the weather in NYC?",
        timestamp: "2024-01-01T00:00:00Z",
      },
      {
        id: "2",
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "tc-1",
            type: "function",
            function: {
              name: "get-weather",
              arguments: '{"location":"NYC"}',
            },
          },
        ],
        timestamp: "2024-01-01T00:00:01Z",
      },
      {
        id: "3",
        role: "tool",
        content: '{"temperature":72,"description":"Sunny"}',
        tool_call_id: "tc-1",
        name: "get-weather",
        timestamp: "2024-01-01T00:00:02Z",
      },
      {
        id: "4",
        role: "assistant",
        content: "The weather in NYC is sunny with 72°F!",
        timestamp: "2024-01-01T00:00:03Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
    expect(result[2].role).toBe("tool");
    expect(result[3].role).toBe("assistant");
    expect(result[3].content).toBe(
      "The weather in NYC is sunny with 72°F!",
    );
  });

  it("should handle empty messages array", () => {
    const result = toAiSdkMessages([]);
    expect(result).toHaveLength(0);
  });

  it("should handle null content gracefully", () => {
    const messages: AgentWorkflowMessage[] = [
      {
        id: "1",
        role: "user",
        content: null,
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = toAiSdkMessages(messages);
    expect(result[0].content).toBe("");
  });
});
