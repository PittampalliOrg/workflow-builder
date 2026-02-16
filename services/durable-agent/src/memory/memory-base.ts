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

export interface MemoryProvider {
  /** Add a single message to memory. */
  addMessage(message: MemoryMessage): Promise<void> | void;
  /** Retrieve all messages from memory. */
  getMessages(): Promise<MemoryMessage[]> | MemoryMessage[];
  /** Clear all messages from memory. */
  reset(): Promise<void> | void;
  /** Optional session identifier. */
  sessionId?: string;
}
