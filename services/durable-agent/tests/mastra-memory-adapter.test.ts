/**
 * Tests for Mastra memory adapter.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MastraMemoryAdapter,
  createMastraMemoryAdapter,
  type MastraMemoryLike,
} from "../src/mastra/memory-adapter.js";

function createMockMastraMemory(): MastraMemoryLike & {
  _threads: Map<string, Array<Record<string, unknown>>>;
} {
  const threads = new Map<string, Array<Record<string, unknown>>>();
  return {
    _threads: threads,
    createThread: vi.fn().mockImplementation(async ({ title }) => {
      const id = `thread-${threads.size + 1}`;
      threads.set(id, []);
      return { id };
    }),
    saveMessages: vi.fn().mockImplementation(async ({ threadId, messages }) => {
      const thread = threads.get(threadId);
      if (thread) thread.push(...messages);
    }),
    recall: vi.fn().mockImplementation(async ({ threadId }) => {
      return { messages: threads.get(threadId) ?? [] };
    }),
  };
}

describe("MastraMemoryAdapter", () => {
  it("should create a thread on first operation", async () => {
    const mock = createMockMastraMemory();
    const adapter = new MastraMemoryAdapter(mock, "session-1");

    await adapter.addMessage({ role: "user", content: "Hello" });

    expect(mock.createThread).toHaveBeenCalledTimes(1);
    expect(mock.saveMessages).toHaveBeenCalledTimes(1);
  });

  it("should reuse the same thread for subsequent operations", async () => {
    const mock = createMockMastraMemory();
    const adapter = new MastraMemoryAdapter(mock);

    await adapter.addMessage({ role: "user", content: "Hello" });
    await adapter.addMessage({ role: "assistant", content: "Hi!" });

    // Should only create one thread
    expect(mock.createThread).toHaveBeenCalledTimes(1);
    expect(mock.saveMessages).toHaveBeenCalledTimes(2);
  });

  it("should retrieve messages from the thread", async () => {
    const mock = createMockMastraMemory();
    const adapter = new MastraMemoryAdapter(mock);

    await adapter.addMessage({ role: "user", content: "Hello" });
    await adapter.addMessage({ role: "assistant", content: "Hi!" });

    const messages = await adapter.getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hi!");
  });

  it("should preserve tool message properties", async () => {
    const mock = createMockMastraMemory();
    const adapter = new MastraMemoryAdapter(mock);

    await adapter.addMessage({
      role: "tool",
      content: '{"temperature":72}',
      name: "get-weather",
      tool_call_id: "tc-1",
    });

    expect(mock.saveMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            role: "tool",
            content: '{"temperature":72}',
            name: "get-weather",
            tool_call_id: "tc-1",
          }),
        ],
      }),
    );
  });

  it("should reset by starting a new thread", async () => {
    const mock = createMockMastraMemory();
    const adapter = new MastraMemoryAdapter(mock, "s1");

    await adapter.addMessage({ role: "user", content: "Hello" });
    const sessionBefore = adapter.sessionId;

    await adapter.reset();

    // After reset, next operation creates a new thread
    await adapter.addMessage({ role: "user", content: "New conversation" });
    expect(mock.createThread).toHaveBeenCalledTimes(2);
    expect(adapter.sessionId).not.toBe(sessionBefore);
  });

  it("should expose sessionId", () => {
    const mock = createMockMastraMemory();
    const adapter = new MastraMemoryAdapter(mock, "my-session");
    expect(adapter.sessionId).toBe("my-session");
  });
});

describe("createMastraMemoryAdapter", () => {
  it("should create adapter from valid memory object", () => {
    const mock = createMockMastraMemory();
    const adapter = createMastraMemoryAdapter(mock, "session-1");
    expect(adapter).toBeInstanceOf(MastraMemoryAdapter);
  });

  it("should return null for null/undefined", () => {
    expect(createMastraMemoryAdapter(null)).toBeNull();
    expect(createMastraMemoryAdapter(undefined)).toBeNull();
  });

  it("should return null for objects missing required methods", () => {
    expect(createMastraMemoryAdapter({ createThread: () => {} })).toBeNull();
    expect(createMastraMemoryAdapter({ foo: "bar" })).toBeNull();
  });
});
