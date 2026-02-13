import { useCallback } from "react";
import type { App } from "@modelcontextprotocol/ext-apps";

export function useTodoApi(app: App | null) {
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
    listTaskLists: () =>
      callTool("find_task_list_by_name", { name: "", match_type: "contains" }),
    listTasks: (listId: string) =>
      callTool("find_task_by_title", {
        task_list_id: listId,
        title: "",
        match_type: "contains",
      }),
    createTask: (
      listId: string,
      title: string,
      extra?: Record<string, unknown>,
    ) => callTool("create_task", { task_list_id: listId, title, ...extra }),
    updateTask: (
      listId: string,
      taskId: string,
      fields: Record<string, unknown>,
    ) =>
      callTool("update_task", {
        task_list_id: listId,
        task_id: taskId,
        ...fields,
      }),
    completeTask: (listId: string, taskId: string) =>
      callTool("complete_task", { task_list_id: listId, task_id: taskId }),
    deleteTask: (listId: string, taskId: string) =>
      callTool("delete_task", { task_list_id: listId, task_id: taskId }),
    getTask: (listId: string, taskId: string) =>
      callTool("get_task", { task_list_id: listId, task_id: taskId }),
    createList: (name: string) =>
      callTool("create_task_list", { displayName: name }),
    updateList: (listId: string, name: string) =>
      callTool("update_task_list", {
        task_list_id: listId,
        displayName: name,
      }),
    searchTasks: (
      listId: string,
      title: string,
      matchType = "contains",
    ) =>
      callTool("find_task_by_title", {
        task_list_id: listId,
        title,
        match_type: matchType,
      }),
  };
}

export type TodoApi = ReturnType<typeof useTodoApi>;
