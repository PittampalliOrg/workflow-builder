/**
 * Dapr state-backed persistent conversation memory.
 * Mirrors Python dapr_agents/memory/daprstatestore.py.
 */

import { DaprClient } from "@dapr/dapr";
import type { MemoryProvider, MemoryMessage } from "./memory-base.js";
import { withEtagRetry } from "../state/etag-retry.js";

export class DaprStateMemory implements MemoryProvider {
  private client: DaprClient;
  private storeName: string;
  public sessionId: string;

  constructor(client: DaprClient, storeName: string, sessionId?: string) {
    this.client = client;
    this.storeName = storeName;
    this.sessionId = sessionId ?? crypto.randomUUID();
  }

  private get stateKey(): string {
    return `conversation:${this.sessionId}`;
  }

  async addMessage(message: MemoryMessage): Promise<void> {
    const enriched = {
      ...message,
      createdAt: new Date().toISOString(),
    };

    await withEtagRetry(async () => {
      const existing = await this.client.state.get(
        this.storeName,
        this.stateKey,
      );
      const messages: MemoryMessage[] = Array.isArray(existing)
        ? existing
        : [];
      messages.push(enriched);
      await this.client.state.save(this.storeName, [
        { key: this.stateKey, value: messages },
      ]);
    });
  }

  async getMessages(): Promise<MemoryMessage[]> {
    const raw = await this.client.state.get(this.storeName, this.stateKey);
    if (Array.isArray(raw)) {
      return raw;
    }
    return [];
  }

  async reset(): Promise<void> {
    await this.client.state.delete(this.storeName, this.stateKey);
  }
}
