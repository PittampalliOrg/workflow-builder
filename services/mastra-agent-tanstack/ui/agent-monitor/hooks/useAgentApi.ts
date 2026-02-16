import { useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";

export function useAgentApi(app: App | null) {
  const callTool = useCallback(
    async (name: string, args: Record<string, unknown> = {}) => {
      if (!app) throw new Error("App not connected");
      const result = await app.callServerTool({ name, arguments: args });
      const textItem = (
        result.content as Array<{ type: string; text?: string }>
      )?.find((c) => c.type === "text");
      const text = textItem?.text;
      if ((result as any).isError) {
        throw new Error(text || "Tool call failed");
      }
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(text);
      }
    },
    [app],
  );

  return {
    getAgentStatus: () => callTool("get_agent_status"),

    runAgent: (prompt: string) => callTool("run_agent", { prompt }),

    getWorkflowContext: () => callTool("get_workflow_context"),

    getEventHistory: (limit?: number) =>
      callTool("get_event_history", limit ? { limit } : {}),

    getLogs: (limit?: number, level?: string) =>
      callTool("get_logs", {
        ...(limit ? { limit } : {}),
        ...(level ? { level } : {}),
      }),

    runWorkflow: (params: {
      workflowId: string;
      prompt: string;
      repo_owner?: string;
      repo_name?: string;
      branch?: string;
    }) => callTool("run_workflow", params),

    getWorkflowExecutionStatus: (instanceId: string) =>
      callTool("get_workflow_execution_status", { instanceId }),

    approveWorkflow: (params: {
      instanceId: string;
      eventName: string;
      approved: boolean;
      reason?: string;
    }) => callTool("approve_workflow", params),
  };
}

export type AgentApi = ReturnType<typeof useAgentApi>;
