import { useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";

export function useAgentApi(app: App | null) {
  const callTool = useCallback(
    async (name: string, args: Record<string, unknown> = {}) => {
      if (!app) throw new Error("App not connected");
      const result = await app.callServerTool({ name, arguments: args });
      const text = (
        result.content as Array<{ type: string; text?: string }>
      )?.find((c) => c.type === "text")?.text;
      return text ? JSON.parse(text) : null;
    },
    [app],
  );

  return {
    getAgentStatus: () => callTool("get_agent_status"),

    runAgent: (prompt: string) => callTool("run_agent", { prompt }),

    getWorkflowContext: () => callTool("get_workflow_context"),

    getEventHistory: (limit?: number) =>
      callTool("get_event_history", limit ? { limit } : {}),
  };
}

export type AgentApi = ReturnType<typeof useAgentApi>;
