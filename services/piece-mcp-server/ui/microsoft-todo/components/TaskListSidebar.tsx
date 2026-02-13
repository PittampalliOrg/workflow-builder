import { useState, useEffect } from "react";
import type { TodoApi } from "../hooks/useTodoApi";
import type { TaskList } from "../App";

interface Props {
  api: TodoApi;
  selectedId: string | null;
  onSelect: (list: TaskList) => void;
  refreshKey: number;
}

export function TaskListSidebar({ api, selectedId, onSelect, refreshKey }: Props) {
  const [lists, setLists] = useState<TaskList[]>([]);
  const [loading, setLoading] = useState(true);
  const [newListName, setNewListName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listTaskLists()
      .then((data) => {
        if (cancelled) return;
        const items = Array.isArray(data) ? data : data?.value ?? [];
        setLists(items);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, refreshKey]);

  const handleCreate = async () => {
    const name = newListName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await api.createList(name);
      setNewListName("");
      // Refresh lists
      const data = await api.listTaskLists();
      const items = Array.isArray(data) ? data : data?.value ?? [];
      setLists(items);
    } catch (err) {
      console.error("Failed to create list:", err);
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h2>Lists</h2>
      </div>
      <div className="sidebar-content">
        {loading ? (
          <div className="loading-container">
            <div className="spinner" />
          </div>
        ) : lists.length === 0 ? (
          <div className="empty-state">No task lists found</div>
        ) : (
          <ul className="list-items">
            {lists.map((list) => (
              <li
                key={list.id}
                className={`list-item ${selectedId === list.id ? "selected" : ""}`}
                onClick={() => onSelect(list)}
              >
                <span className="list-icon">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M2 4h12M2 8h12M2 12h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="list-name">{list.displayName}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sidebar-footer">
        <div className="new-list-input">
          <input
            type="text"
            placeholder="New list..."
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            disabled={creating}
          />
          <button
            className="btn-icon"
            onClick={handleCreate}
            disabled={!newListName.trim() || creating}
            title="Create list"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>
    </aside>
  );
}
