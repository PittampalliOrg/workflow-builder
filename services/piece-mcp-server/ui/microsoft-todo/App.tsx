import { useState, useCallback } from "react";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { TaskListSidebar } from "./components/TaskListSidebar";
import { TaskListView } from "./components/TaskListView";
import { TaskDetail } from "./components/TaskDetail";
import { SearchBar } from "./components/SearchBar";
import { useTodoApi } from "./hooks/useTodoApi";

export type TaskList = { id: string; displayName: string };
export type Task = {
  id: string;
  title: string;
  status: string;
  importance: string;
  body?: { content: string; contentType: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  startDateTime?: { dateTime: string; timeZone: string };
  reminderDateTime?: { dateTime: string; timeZone: string };
  categories?: string[];
  completedDateTime?: { dateTime: string; timeZone: string };
};

export default function App() {
  const [initialResult, setInitialResult] = useState<unknown>(null);

  const { app } = useApp({
    appInfo: { name: "Microsoft To Do", version: "1.0.0" },
    onAppCreated: (newApp: McpApp) => {
      newApp.ontoolinput = (
        _params: { arguments?: Record<string, unknown> },
      ) => {};
      newApp.ontoolresult = (result: {
        content?: Array<{ type: string; text?: string }>;
      }) => {
        const text = result.content?.find((c) => c.type === "text")?.text;
        if (text) {
          try {
            setInitialResult(JSON.parse(text));
          } catch {
            setInitialResult(text);
          }
        }
      };
    },
  });
  useHostStyles(app);

  const api = useTodoApi(app);
  const [selectedList, setSelectedList] = useState<TaskList | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [searchResults, setSearchResults] = useState<Task[] | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleRefresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setSelectedTask(null);
    setSearchResults(null);
  }, []);

  return (
    <div className="todo-app">
      <SearchBar
        api={api}
        selectedListId={selectedList?.id ?? null}
        onResults={setSearchResults}
        onClear={() => setSearchResults(null)}
      />
      <div className="todo-layout">
        <TaskListSidebar
          api={api}
          selectedId={selectedList?.id ?? null}
          onSelect={(list) => {
            setSelectedList(list);
            setSelectedTask(null);
            setSearchResults(null);
          }}
          refreshKey={refreshKey}
        />
        <TaskListView
          api={api}
          list={selectedList}
          tasks={searchResults}
          onSelectTask={setSelectedTask}
          onRefresh={handleRefresh}
          refreshKey={refreshKey}
        />
        {selectedTask && selectedList && (
          <TaskDetail
            api={api}
            listId={selectedList.id}
            task={selectedTask}
            onClose={() => setSelectedTask(null)}
            onUpdate={handleRefresh}
          />
        )}
      </div>
    </div>
  );
}
