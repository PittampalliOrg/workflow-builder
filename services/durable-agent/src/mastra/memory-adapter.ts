/**
 * Mastra Memory Adapter — bridges Mastra Memory to durable-agent MemoryProvider.
 *
 * Maps workflow instance IDs to Mastra thread IDs.
 * Falls back gracefully if @mastra/memory is not installed.
 */

import type { MemoryProvider, MemoryMessage } from "../memory/memory-base.js";

/**
 * Structural interface matching Mastra Memory.
 * Avoids compile-time @mastra/memory dependency.
 */
export interface MastraMemoryLike {
  createThread(opts: { title?: string }): Promise<{ id: string }>;
  saveMessages(opts: {
    threadId: string;
    messages: Array<{ role: string; content: string; [key: string]: unknown }>;
  }): Promise<void>;
  recall(opts: {
    threadId: string;
    config?: unknown;
  }): Promise<{
    messages: Array<{ role: string; content: string; [key: string]: unknown }>;
  }>;
}

/**
 * Adapts a Mastra Memory instance to the durable-agent MemoryProvider interface.
 */
export class MastraMemoryAdapter implements MemoryProvider {
  private memory: MastraMemoryLike;
  private threadId: string | null = null;
  private _sessionId: string;
  private threadInitPromise: Promise<void> | null = null;

  constructor(memory: MastraMemoryLike, sessionId?: string) {
    this.memory = memory;
    this._sessionId = sessionId ?? `durable-${Date.now()}`;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  /**
   * Ensure the Mastra thread is created (idempotent).
   */
  private async ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId;

    if (!this.threadInitPromise) {
      this.threadInitPromise = (async () => {
        const thread = await this.memory.createThread({
          title: `durable-agent-${this._sessionId}`,
        });
        this.threadId = thread.id;
        console.log(
          `[memory-adapter] Created Mastra thread: ${this.threadId} (session: ${this._sessionId})`,
        );
      })();
    }

    await this.threadInitPromise;
    return this.threadId!;
  }

  async addMessage(message: MemoryMessage): Promise<void> {
    const threadId = await this.ensureThread();
    await this.memory.saveMessages({
      threadId,
      messages: [
        {
          role: message.role,
          content: message.content,
          ...(message.name ? { name: message.name } : {}),
          ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
        },
      ],
    });
  }

  async getMessages(): Promise<MemoryMessage[]> {
    const threadId = await this.ensureThread();
    const result = await this.memory.recall({ threadId });

    return result.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ...(m.name ? { name: m.name as string } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id as string } : {}),
    }));
  }

  async reset(): Promise<void> {
    // Reset by starting a new thread
    this.threadId = null;
    this.threadInitPromise = null;
    this._sessionId = `durable-${Date.now()}`;
    console.log("[memory-adapter] Reset — will create new thread on next operation");
  }
}

/**
 * Attempt to create a MastraMemoryAdapter from a raw memory object.
 * Returns null if the object doesn't look like a Mastra Memory instance.
 */
export function createMastraMemoryAdapter(
  memory: unknown,
  sessionId?: string,
): MastraMemoryAdapter | null {
  if (!memory || typeof memory !== "object") return null;

  const m = memory as Record<string, unknown>;
  if (
    typeof m.createThread === "function" &&
    typeof m.saveMessages === "function" &&
    typeof m.recall === "function"
  ) {
    return new MastraMemoryAdapter(m as unknown as MastraMemoryLike, sessionId);
  }

  console.warn(
    "[memory-adapter] Provided memory object does not match MastraMemoryLike interface",
  );
  return null;
}
