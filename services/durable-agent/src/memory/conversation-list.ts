/**
 * In-memory conversation list (default memory provider).
 * Mirrors Python dapr_agents/memory/liststore.py.
 */

import type { MemoryProvider, MemoryMessage } from "./memory-base.js";

export class ConversationListMemory implements MemoryProvider {
  private messages: MemoryMessage[] = [];
  public sessionId?: string;

  constructor(sessionId?: string) {
    this.sessionId = sessionId;
  }

  addMessage(message: MemoryMessage): void {
    this.messages.push({ ...message });
  }

  getMessages(): MemoryMessage[] {
    return [...this.messages];
  }

  reset(): void {
    this.messages = [];
  }
}
