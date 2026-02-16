/**
 * Tests for memory providers.
 */
import { describe, it, expect } from "vitest";
import { ConversationListMemory } from "../src/memory/conversation-list.js";

describe("ConversationListMemory", () => {
  it("should start empty", () => {
    const memory = new ConversationListMemory();
    expect(memory.getMessages()).toHaveLength(0);
  });

  it("should add and retrieve messages", () => {
    const memory = new ConversationListMemory();
    memory.addMessage({ role: "user", content: "Hello" });
    memory.addMessage({ role: "assistant", content: "Hi!" });

    const messages = memory.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].content).toBe("Hi!");
  });

  it("should return copies (not references)", () => {
    const memory = new ConversationListMemory();
    memory.addMessage({ role: "user", content: "Hello" });

    const messages1 = memory.getMessages();
    const messages2 = memory.getMessages();
    expect(messages1).not.toBe(messages2);
    expect(messages1).toEqual(messages2);
  });

  it("should not mutate stored messages via returned array", () => {
    const memory = new ConversationListMemory();
    memory.addMessage({ role: "user", content: "Hello" });

    const messages = memory.getMessages();
    messages.push({ role: "assistant", content: "added externally" });

    expect(memory.getMessages()).toHaveLength(1);
  });

  it("should reset memory", () => {
    const memory = new ConversationListMemory();
    memory.addMessage({ role: "user", content: "Hello" });
    memory.addMessage({ role: "assistant", content: "Hi!" });
    expect(memory.getMessages()).toHaveLength(2);

    memory.reset();
    expect(memory.getMessages()).toHaveLength(0);
  });

  it("should store session ID", () => {
    const memory = new ConversationListMemory("session-123");
    expect(memory.sessionId).toBe("session-123");
  });

  it("should preserve message properties", () => {
    const memory = new ConversationListMemory();
    memory.addMessage({
      role: "tool",
      content: '{"temperature":72}',
      name: "get-weather",
      tool_call_id: "tc-1",
    });

    const messages = memory.getMessages();
    expect(messages[0].name).toBe("get-weather");
    expect(messages[0].tool_call_id).toBe("tc-1");
  });
});
