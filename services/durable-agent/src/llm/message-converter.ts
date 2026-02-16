/**
 * Convert AgentWorkflowMessage <-> AI SDK ModelMessage.
 * Extended from mastra-agent/src/workflow/activities.ts:44-89.
 */

import type { ModelMessage } from "ai";
import type { AgentWorkflowMessage } from "../types/state.js";

/** Convert stored workflow messages into AI SDK ModelMessage format. */
export function toAiSdkMessages(
  messages: AgentWorkflowMessage[],
): ModelMessage[] {
  return messages
    .filter((msg) => msg.role !== "system")
    .map((msg): ModelMessage => {
      if (msg.role === "user") {
        return { role: "user", content: msg.content ?? "" };
      }

      if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts: any[] = [];
          if (msg.content) {
            parts.push({ type: "text", text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            });
          }
          return { role: "assistant", content: parts };
        }
        return { role: "assistant", content: msg.content ?? "" };
      }

      if (msg.role === "tool") {
        // AI SDK 6 output is a discriminated union: { type: "json", value: ... } or { type: "text", value: "..." }
        let output: { type: "json"; value: unknown } | { type: "text"; value: string };
        try {
          const parsed = JSON.parse(msg.content ?? "{}");
          output = { type: "json", value: parsed };
        } catch {
          output = { type: "text", value: msg.content ?? "" };
        }
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.tool_call_id!,
              toolName: msg.name ?? "",
              output,
            } as any,
          ],
        };
      }

      // Fallback for any other role
      return { role: "user", content: msg.content ?? "" };
    });
}
