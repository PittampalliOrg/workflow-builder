/**
 * Processor Adapter — pre-LLM guardrail pipeline.
 *
 * Runs Mastra processors (prompt injection detection, PII filtering, moderation)
 * sequentially on messages before they reach the LLM.
 */

import type { AgentWorkflowMessage } from "../types/state.js";

/**
 * Structural interface matching a Mastra processor.
 * Avoids compile-time @mastra/core dependency.
 */
export interface ProcessorLike {
  id: string;
  processInput?(args: {
    messages: Array<{ role: string; content: string }>;
    abort: (reason?: string) => never;
  }): Promise<Array<{ role: string; content: string }>>;
}

/**
 * Run input processors sequentially on messages before LLM call.
 *
 * If a processor calls abort(), the error propagates up and the LLM call
 * is skipped. The workflow can catch this and return an appropriate response.
 *
 * @param processors - Array of Mastra-compatible processors
 * @param messages - Conversation messages to process
 * @returns Processed messages (may be modified by processors)
 * @throws Error if a processor aborts with a reason
 */
export async function runInputProcessors(
  processors: ProcessorLike[],
  messages: AgentWorkflowMessage[],
): Promise<AgentWorkflowMessage[]> {
  if (processors.length === 0) return messages;

  // Convert to simplified format for processors
  let simplified = messages.map((m) => ({
    role: m.role,
    content: m.content ?? "",
  }));

  for (const processor of processors) {
    if (!processor.processInput) continue;

    const abort = (reason?: string): never => {
      throw new ProcessorAbortError(
        reason ?? `Processor "${processor.id}" aborted the request`,
        processor.id,
      );
    };

    simplified = await processor.processInput({
      messages: simplified,
      abort,
    }) as typeof simplified;
  }

  // Map processed messages back to AgentWorkflowMessage format.
  // Preserve original metadata (id, timestamp, tool_calls, etc.) for messages
  // that weren't removed, and create new entries for any added messages.
  const result: AgentWorkflowMessage[] = [];
  for (let i = 0; i < simplified.length; i++) {
    const processed = simplified[i];
    // Try to match with original by index (processors typically preserve order)
    const original = i < messages.length ? messages[i] : undefined;

    if (original && original.role === processed.role) {
      // Preserve original metadata, update content
      result.push({
        ...original,
        content: processed.content,
      });
    } else {
      // New or reordered message from processor
      result.push({
        id: crypto.randomUUID(),
        role: processed.role as AgentWorkflowMessage["role"],
        content: processed.content,
        timestamp: new Date().toISOString(),
      });
    }
  }

  return result;
}

/**
 * Error thrown when a processor aborts the request.
 */
export class ProcessorAbortError extends Error {
  readonly processorId: string;

  constructor(message: string, processorId: string) {
    super(message);
    this.name = "ProcessorAbortError";
    this.processorId = processorId;
  }
}

/**
 * Instantiate processors from a comma-separated config string.
 * Dynamically imports @mastra/core processors if available.
 *
 * @param config - e.g., "prompt-injection,pii,moderation"
 * @returns Array of processor instances
 */
export async function createProcessors(
  config: string,
): Promise<ProcessorLike[]> {
  if (!config.trim()) return [];

  const names = config.split(",").map((s) => s.trim()).filter(Boolean);
  const processors: ProcessorLike[] = [];

  for (const name of names) {
    try {
      const processor = await loadProcessor(name);
      if (processor) {
        processors.push(processor);
        console.log(`[processors] Loaded processor: ${name}`);
      }
    } catch (err) {
      console.warn(`[processors] Failed to load processor "${name}": ${err}`);
    }
  }

  return processors;
}

async function loadProcessor(name: string): Promise<ProcessorLike | null> {
  try {
    // @ts-expect-error optional peer dependency
    const mastraCore = await import("@mastra/core");
    const mod = mastraCore as any;

    switch (name) {
      case "prompt-injection": {
        const Cls = mod.PromptInjectionDetector;
        return Cls ? new Cls() : null;
      }
      case "pii": {
        const Cls = mod.PIIDetector;
        return Cls ? new Cls() : null;
      }
      case "moderation": {
        const Cls = mod.ModerationProcessor;
        return Cls ? new Cls() : null;
      }
      default:
        console.warn(`[processors] Unknown processor name: ${name}`);
        return null;
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND")) {
      console.log(
        `[processors] @mastra/core not installed, cannot load processor "${name}"`,
      );
    } else {
      console.warn(`[processors] Error loading processor "${name}": ${msg}`);
    }
    return null;
  }
}
