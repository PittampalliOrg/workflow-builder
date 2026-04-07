/**
 * Dapr state-backed persistent conversation memory.
 * Mirrors Python dapr_agents/memory/daprstatestore.py.
 */

import { DaprClient } from "@dapr/dapr";
import { randomUUID } from "node:crypto";
import type {
  MemoryProvider,
  MemoryMessage,
  MemoryRecallResult,
  MemorySnapshotRef,
  MemoryWorkingSet,
} from "./memory-base.js";
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

  private runStateKey(instanceId: string): string {
    return `conversation:${this.sessionId}:${instanceId}`;
  }

  private snapshotStateKey(instanceId: string): string {
    return `conversation_snapshots:${this.sessionId}:${instanceId}`;
  }

  private async getMessagesForKey(key: string): Promise<MemoryMessage[]> {
    const raw = await this.client.state.get(this.storeName, key);
    return Array.isArray(raw) ? (raw as MemoryMessage[]) : [];
  }

  private async saveMessagesForKey(
    key: string,
    messages: MemoryMessage[],
  ): Promise<void> {
    await this.client.state.save(this.storeName, [{ key, value: messages }]);
  }

  private async getSnapshots(instanceId: string): Promise<MemorySnapshotRef[]> {
    const raw = await this.client.state.get(
      this.storeName,
      this.snapshotStateKey(instanceId),
    );
    return Array.isArray(raw) ? (raw as MemorySnapshotRef[]) : [];
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
    return this.getMessagesForKey(this.stateKey);
  }

  async loadWorkingSet(input: {
    instanceId: string;
    query?: string;
    recentLimit?: number;
    recallLimit?: number;
  }): Promise<MemoryWorkingSet | undefined> {
    const messages = await this.getMessagesForKey(this.runStateKey(input.instanceId));
    if (messages.length === 0) return undefined;
    const recentLimit = Math.max(1, input.recentLimit ?? 8);
    const snapshots = await this.getSnapshots(input.instanceId);
    const snapshot = snapshots.at(-1);
    const recalledMessages =
      input.query && input.query.trim()
        ? await this.recall({
            instanceId: input.instanceId,
            query: input.query,
            limit: input.recallLimit,
          })
        : [];
    return {
      ...(snapshot ? { snapshot, summary: snapshot.summary } : {}),
      recentMessages: messages.slice(-recentLimit),
      ...(recalledMessages.length > 0 ? { recalledMessages } : {}),
    };
  }

  async appendTurn(input: {
    instanceId: string;
    messages: MemoryMessage[];
  }): Promise<void> {
    const key = this.runStateKey(input.instanceId);
    await withEtagRetry(async () => {
      const existing = await this.getMessagesForKey(key);
      await this.saveMessagesForKey(key, [
        ...existing,
        ...input.messages.map((message) => ({ ...message })),
      ]);
    });
  }

  async recall(input: {
    instanceId: string;
    query: string;
    limit?: number;
  }): Promise<MemoryRecallResult[]> {
    const messages = await this.getMessagesForKey(this.runStateKey(input.instanceId));
    const terms = input.query
      .toLowerCase()
      .split(/\W+/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (terms.length === 0) return [];
    const limit = Math.max(1, input.limit ?? 5);
    return messages
      .map((message) => ({
        message,
        score: terms.reduce((score, term) => {
          return message.content.toLowerCase().includes(term) ? score + 1 : score;
        }, 0),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  async compact(input: {
    instanceId: string;
    summary: string;
    preserveRecentMessages?: number;
    summarizedMessages?: number;
  }): Promise<MemorySnapshotRef> {
    const snapshot: MemorySnapshotRef = {
      id: randomUUID(),
      summary: input.summary,
      createdAt: new Date().toISOString(),
      ...(typeof input.summarizedMessages === "number"
        ? { summarizedMessages: input.summarizedMessages }
        : {}),
    };
    const snapshots = await this.getSnapshots(input.instanceId);
    snapshots.push(snapshot);
    await this.client.state.save(this.storeName, [
      {
        key: this.snapshotStateKey(input.instanceId),
        value: snapshots,
      },
    ]);

    const preserveRecentMessages = Math.max(1, input.preserveRecentMessages ?? 8);
    const key = this.runStateKey(input.instanceId);
    await withEtagRetry(async () => {
      const existing = await this.getMessagesForKey(key);
      await this.saveMessagesForKey(key, existing.slice(-preserveRecentMessages));
    });

    return snapshot;
  }

  async resetRun(instanceId: string): Promise<void> {
    await Promise.all([
      this.client.state.delete(this.storeName, this.runStateKey(instanceId)),
      this.client.state.delete(this.storeName, this.snapshotStateKey(instanceId)),
    ]);
  }

  async reset(): Promise<void> {
    await this.client.state.delete(this.storeName, this.stateKey);
  }
}
