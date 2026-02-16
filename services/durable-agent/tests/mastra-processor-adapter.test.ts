/**
 * Tests for processor adapter (pre-LLM guardrails).
 */
import { describe, it, expect } from "vitest";
import {
  runInputProcessors,
  ProcessorAbortError,
  type ProcessorLike,
} from "../src/mastra/processor-adapter.js";
import type { AgentWorkflowMessage } from "../src/types/state.js";

function makeMessages(contents: string[]): AgentWorkflowMessage[] {
  return contents.map((content, i) => ({
    id: `msg-${i}`,
    role: "user" as const,
    content,
    timestamp: "2024-01-01T00:00:00Z",
  }));
}

describe("runInputProcessors", () => {
  it("should return messages unchanged when no processors", async () => {
    const messages = makeMessages(["Hello"]);
    const result = await runInputProcessors([], messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("Hello");
  });

  it("should run processors sequentially", async () => {
    const log: string[] = [];

    const processor1: ProcessorLike = {
      id: "p1",
      async processInput({ messages }) {
        log.push("p1");
        return messages.map((m) => ({ ...m, content: m.content + " [p1]" }));
      },
    };

    const processor2: ProcessorLike = {
      id: "p2",
      async processInput({ messages }) {
        log.push("p2");
        return messages.map((m) => ({ ...m, content: m.content + " [p2]" }));
      },
    };

    const messages = makeMessages(["Hello"]);
    const result = await runInputProcessors([processor1, processor2], messages);

    expect(log).toEqual(["p1", "p2"]);
    expect(result[0].content).toBe("Hello [p1] [p2]");
  });

  it("should preserve original message metadata", async () => {
    const processor: ProcessorLike = {
      id: "passthrough",
      async processInput({ messages }) {
        return messages;
      },
    };

    const messages: AgentWorkflowMessage[] = [
      {
        id: "original-id",
        role: "user",
        content: "Hello",
        timestamp: "2024-01-01T00:00:00Z",
      },
    ];

    const result = await runInputProcessors([processor], messages);
    expect(result[0].id).toBe("original-id");
    expect(result[0].timestamp).toBe("2024-01-01T00:00:00Z");
  });

  it("should handle abort from processor", async () => {
    const blocker: ProcessorLike = {
      id: "blocker",
      async processInput({ abort }) {
        abort("Dangerous content detected");
      },
    };

    const messages = makeMessages(["Some bad input"]);

    await expect(
      runInputProcessors([blocker], messages),
    ).rejects.toThrow(ProcessorAbortError);

    try {
      await runInputProcessors([blocker], messages);
    } catch (err) {
      expect(err).toBeInstanceOf(ProcessorAbortError);
      expect((err as ProcessorAbortError).processorId).toBe("blocker");
      expect((err as ProcessorAbortError).message).toBe(
        "Dangerous content detected",
      );
    }
  });

  it("should skip processors without processInput", async () => {
    const noOp: ProcessorLike = {
      id: "no-op",
      // no processInput method
    };

    const messages = makeMessages(["Hello"]);
    const result = await runInputProcessors([noOp], messages);
    expect(result[0].content).toBe("Hello");
  });
});

describe("ProcessorAbortError", () => {
  it("should have correct name and properties", () => {
    const err = new ProcessorAbortError("blocked", "my-processor");
    expect(err.name).toBe("ProcessorAbortError");
    expect(err.message).toBe("blocked");
    expect(err.processorId).toBe("my-processor");
    expect(err).toBeInstanceOf(Error);
  });
});
