/**
 * In-memory conversation list (default memory provider).
 * Mirrors Python dapr_agents/memory/liststore.py.
 */

import { randomUUID } from "node:crypto";
import type {
  MemoryProvider,
  MemoryMessage,
  MemoryRecallResult,
  MemorySnapshotRef,
  MemoryWorkingSet,
} from "./memory-base.js";

export class ConversationListMemory implements MemoryProvider {
  private messages: MemoryMessage[] = [];
  private messagesByRun = new Map<string, MemoryMessage[]>();
  private snapshotsByRun = new Map<string, MemorySnapshotRef[]>();
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

  loadWorkingSet(input: {
    instanceId: string;
    query?: string;
    recentLimit?: number;
    recallLimit?: number;
  }): MemoryWorkingSet | undefined {
    const messages = this.messagesByRun.get(input.instanceId) ?? [];
    if (messages.length === 0) return undefined;
    const recentLimit = Math.max(1, input.recentLimit ?? 8);
    const snapshot = this.snapshotsByRun.get(input.instanceId)?.at(-1);
    const recalledMessages =
      input.query && input.query.trim()
        ? this.recall({
            instanceId: input.instanceId,
            query: input.query,
            limit: input.recallLimit,
          })
        : [];
    return {
      ...(snapshot ? { snapshot, summary: snapshot.summary } : {}),
      recentMessages: messages.slice(-recentLimit).map((message) => ({
        ...message,
      })),
      ...(recalledMessages.length > 0 ? { recalledMessages } : {}),
    };
  }

  appendTurn(input: { instanceId: string; messages: MemoryMessage[] }): void {
    const nextMessages = [
      ...(this.messagesByRun.get(input.instanceId) ?? []),
      ...input.messages.map((message) => ({ ...message })),
    ];
    this.messagesByRun.set(input.instanceId, nextMessages);
  }

  recall(input: {
    instanceId: string;
    query: string;
    limit?: number;
  }): MemoryRecallResult[] {
    const messages = this.messagesByRun.get(input.instanceId) ?? [];
    const terms = input.query
      .toLowerCase()
      .split(/\W+/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (terms.length === 0) return [];
    const limit = Math.max(1, input.limit ?? 5);
    return messages
      .map((message) => ({
        message: { ...message },
        score: terms.reduce((score, term) => {
          return message.content.toLowerCase().includes(term) ? score + 1 : score;
        }, 0),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  compact(input: {
    instanceId: string;
    summary: string;
    preserveRecentMessages?: number;
    summarizedMessages?: number;
  }): MemorySnapshotRef {
    const snapshot: MemorySnapshotRef = {
      id: randomUUID(),
      summary: input.summary,
      createdAt: new Date().toISOString(),
      ...(typeof input.summarizedMessages === "number"
        ? { summarizedMessages: input.summarizedMessages }
        : {}),
    };
    const snapshots = this.snapshotsByRun.get(input.instanceId) ?? [];
    snapshots.push(snapshot);
    this.snapshotsByRun.set(input.instanceId, snapshots);

    const preserveRecentMessages = Math.max(1, input.preserveRecentMessages ?? 8);
    const messages = this.messagesByRun.get(input.instanceId) ?? [];
    this.messagesByRun.set(input.instanceId, messages.slice(-preserveRecentMessages));

    return snapshot;
  }

  resetRun(instanceId: string): void {
    this.messagesByRun.delete(instanceId);
    this.snapshotsByRun.delete(instanceId);
  }

  reset(): void {
    this.messages = [];
    this.messagesByRun.clear();
    this.snapshotsByRun.clear();
  }
}
