import { useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";

export function useWorkflowApi(app: App | null) {
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
    listWorkflows: () => callTool("list_workflows"),

    getWorkflow: (workflowId: string) =>
      callTool("get_workflow", { workflow_id: workflowId }),

    createWorkflow: (name: string, description?: string) =>
      callTool("create_workflow", { name, description }),

    updateWorkflow: (
      workflowId: string,
      fields: { name?: string; description?: string; visibility?: string },
    ) => callTool("update_workflow", { workflow_id: workflowId, ...fields }),

    deleteWorkflow: (workflowId: string) =>
      callTool("delete_workflow", { workflow_id: workflowId }),

    duplicateWorkflow: (workflowId: string) =>
      callTool("duplicate_workflow", { workflow_id: workflowId }),

    addNode: (
      workflowId: string,
      type: string,
      label: string,
      posX?: number,
      posY?: number,
      config?: Record<string, unknown>,
    ) =>
      callTool("add_node", {
        workflow_id: workflowId,
        type,
        label,
        position_x: posX,
        position_y: posY,
        config,
      }),

    updateNode: (
      workflowId: string,
      nodeId: string,
      updates: Record<string, unknown>,
    ) =>
      callTool("update_node", {
        workflow_id: workflowId,
        node_id: nodeId,
        ...updates,
      }),

    deleteNode: (workflowId: string, nodeId: string) =>
      callTool("delete_node", { workflow_id: workflowId, node_id: nodeId }),

    connectNodes: (
      workflowId: string,
      sourceId: string,
      targetId: string,
      sourceHandle?: string,
      targetHandle?: string,
    ) =>
      callTool("connect_nodes", {
        workflow_id: workflowId,
        source_node_id: sourceId,
        target_node_id: targetId,
        source_handle: sourceHandle,
        target_handle: targetHandle,
      }),

    disconnectNodes: (workflowId: string, edgeId: string) =>
      callTool("disconnect_nodes", { workflow_id: workflowId, edge_id: edgeId }),

    listAvailableActions: (search?: string) =>
      callTool("list_available_actions", search ? { search } : {}),

    executeWorkflow: (workflowId: string, triggerData?: Record<string, unknown>) =>
      callTool("execute_workflow", {
        workflow_id: workflowId,
        trigger_data: triggerData,
      }),

    getExecutionStatus: (instanceId: string) =>
      callTool("get_execution_status", { instance_id: instanceId }),

    approveWorkflow: (
      instanceId: string,
      eventName: string,
      approved: boolean,
      reason?: string,
    ) =>
      callTool("approve_workflow", {
        instance_id: instanceId,
        event_name: eventName,
        approved,
        ...(reason ? { reason } : {}),
      }),
  };
}

export type WorkflowApi = ReturnType<typeof useWorkflowApi>;
