import { useState, useEffect } from "react";
import type { TodoApi } from "../hooks/useTodoApi";
import type { TaskList, Task } from "../App";
import { TaskRow } from "./TaskRow";

interface Props {
  api: TodoApi;
  list: TaskList | null;
  tasks: Task[] | null;
  onSelectTask: (task: Task) => void;
  onRefresh: () => void;
  refreshKey: number;
}

export function TaskListView({
  api,
  list,
  tasks: searchResults,
  onSelectTask,
  onRefresh,
  refreshKey,
}: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    if (!list || searchResults) return;
    let cancelled = false;
    setLoading(true);
    api
      .listTasks(list.id)
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data) ? data : data?.value ?? [];
        setTasks(items);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, list, searchResults, refreshKey]);

  const displayTasks = searchResults ?? tasks;
  const activeTasks = displayTasks.filter((t) => t.status !== "completed");
  const completedTasks = displayTasks.filter((t) => t.status === "completed");

  const handleCreate = async () => {
    const title = newTaskTitle.trim();
    if (!title || !list || creating) return;
    setCreating(true);
    try {
      await api.createTask(list.id, title);
      setNewTaskTitle("");
      onRefresh();
    } catch (err) {
      console.error("Failed to create task:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleComplete = async (task: Task) => {
    if (!list) return;
    try {
      await api.completeTask(list.id, task.id);
      onRefresh();
    } catch (err) {
      console.error("Failed to complete task:", err);
    }
  };

  if (!list) {
    return (
      <main className="main-area">
        <div className="empty-state-main">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect x="8" y="10" width="32" height="28" rx="4" stroke="currentColor" strokeWidth="2" />
            <path d="M16 20h16M16 28h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <p>Select a list to view tasks</p>
        </div>
      </main>
    );
  }

  return (
    <main className="main-area">
      <div className="main-header">
        <h2>{searchResults ? "Search Results" : list.displayName}</h2>
        <button className="btn-icon" onClick={onRefresh} title="Refresh">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M13.65 2.35A7.96 7.96 0 008 0a8 8 0 108 8h-2a6 6 0 11-1.76-4.24"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
            <path d="M14 1v4h-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      {!searchResults && (
        <div className="add-task-bar">
          <input
            type="text"
            placeholder="Add a task..."
            value={newTaskTitle}
            onChange={(e) => setNewTaskTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            disabled={creating}
          />
          <button
            className="btn-primary btn-sm"
            onClick={handleCreate}
            disabled={!newTaskTitle.trim() || creating}
          >
            Add
          </button>
        </div>
      )}

      {loading ? (
        <div className="loading-container">
          <div className="spinner" />
        </div>
      ) : activeTasks.length === 0 && completedTasks.length === 0 ? (
        <div className="empty-state-main">
          <p>{searchResults ? "No matching tasks found" : "No tasks yet. Add one above!"}</p>
        </div>
      ) : (
        <div className="task-list">
          {activeTasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onSelect={onSelectTask}
              onComplete={handleComplete}
            />
          ))}

          {completedTasks.length > 0 && (
            <div className="completed-section">
              <button
                className="completed-toggle"
                onClick={() => setShowCompleted((v) => !v)}
              >
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  className={`chevron ${showCompleted ? "open" : ""}`}
                >
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span>Completed ({completedTasks.length})</span>
              </button>
              {showCompleted &&
                completedTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onSelect={onSelectTask}
                    onComplete={handleComplete}
                  />
                ))}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
