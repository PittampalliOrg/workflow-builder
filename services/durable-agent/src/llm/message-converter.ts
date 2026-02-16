/**
 * Convert AgentWorkflowMessage <-> AI SDK CoreMessage.
 * Extended from mastra-agent/src/workflow/activities.ts:44-89.
 */

import type { CoreMessage } from "ai";
import type { AgentWorkflowMessage } from "../types/state.js";

/** Convert stored workflow messages into AI SDK CoreMessage format. */
export function toAiSdkMessages(
  messages: AgentWorkflowMessage[],
): CoreMessage[] {
  return messages
    .filter((msg) => msg.role !== "system")
    .map((msg): CoreMessage => {
      if (msg.role === "user") {
        return { role: "user", content: msg.content ?? "" };
      }

      if (msg.role === "assistant") {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts: Array<
            | { type: "text"; text: string }
            | {
                type: "tool-call";
                toolCallId: string;
                toolName: string;
                args: Record<string, unknown>;
              }
          > = [];
          if (msg.content) {
            parts.push({ type: "text", text: msg.content });
          }
          for (const tc of msg.tool_calls) {
            parts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            });
          }
          return { role: "assistant", content: parts };
        }
        return { role: "assistant", content: msg.content ?? "" };
      }

      if (msg.role === "tool") {
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: msg.tool_call_id!,
              toolName: msg.name ?? "",
              result: msg.content,
            },
          ],
        };
      }

      // Fallback for any other role
      return { role: "user", content: msg.content ?? "" };
    });
}
