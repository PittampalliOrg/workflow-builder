import { useState, useRef, useEffect } from "react";
import type { TodoApi } from "../hooks/useTodoApi";
import type { Task } from "../App";

interface Props {
  api: TodoApi;
  selectedListId: string | null;
  onResults: (tasks: Task[]) => void;
  onClear: () => void;
}

export function SearchBar({ api, selectedListId, onResults, onClear }: Props) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!query.trim()) {
      onClear();
      return;
    }

    if (!selectedListId) return;

    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await api.searchTasks(selectedListId, query.trim());
        const items = Array.isArray(data) ? data : data?.value ?? [];
        onResults(items);
      } catch (err) {
        console.error("Search failed:", err);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, selectedListId, api, onResults, onClear]);

  const handleClear = () => {
    setQuery("");
    onClear();
  };

  return (
    <div className="search-bar">
      <div className="search-input-wrapper">
        <svg
          className="search-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
        >
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input
          type="text"
          placeholder={
            selectedListId
              ? "Search tasks..."
              : "Select a list to search..."
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!selectedListId}
        />
        {searching && <div className="spinner spinner-sm" />}
        {query && (
          <button className="btn-icon btn-clear" onClick={handleClear} title="Clear">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
