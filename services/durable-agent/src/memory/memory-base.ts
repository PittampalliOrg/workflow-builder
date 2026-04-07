/**
 * Memory provider interface.
 * Mirrors Python dapr_agents/memory/base.py.
 */

export interface MemoryMessage {
  role: string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
  [key: string]: unknown;
}

export interface MemoryRecallResult {
  message: MemoryMessage;
  score: number;
}

export interface MemorySnapshotRef {
  id: string;
  summary: string;
  createdAt: string;
  summarizedMessages?: number;
}

export interface MemoryWorkingSet {
  summary?: string;
  recentMessages?: MemoryMessage[];
  recalledMessages?: MemoryRecallResult[];
  snapshot?: MemorySnapshotRef;
}

export interface MemoryProvider {
  /** Add a single message to memory. */
  addMessage(message: MemoryMessage): Promise<void> | void;
  /** Retrieve all messages from memory. */
  getMessages(): Promise<MemoryMessage[]> | MemoryMessage[];
  /** Clear all messages from memory. */
  reset(): Promise<void> | void;
  /** Optional session identifier. */
  sessionId?: string;
  /** Optional run-scoped working set loader. */
  loadWorkingSet?(
    input: {
      instanceId: string;
      query?: string;
      recentLimit?: number;
      recallLimit?: number;
    },
  ): Promise<MemoryWorkingSet | undefined> | MemoryWorkingSet | undefined;
  /** Optional batch append hook for run-scoped turns. */
  appendTurn?(
    input: { instanceId: string; messages: MemoryMessage[] },
  ): Promise<void> | void;
  /** Optional run-scoped recall hook. */
  recall?(
    input: { instanceId: string; query: string; limit?: number },
  ): Promise<MemoryRecallResult[]> | MemoryRecallResult[];
  /** Optional compaction hook for external memory implementations. */
  compact?(
    input: {
      instanceId: string;
      summary: string;
      preserveRecentMessages?: number;
      summarizedMessages?: number;
    },
  ): Promise<MemorySnapshotRef | undefined> | MemorySnapshotRef | undefined;
  /** Optional run-scoped reset hook. */
  resetRun?(instanceId: string): Promise<void> | void;
}
