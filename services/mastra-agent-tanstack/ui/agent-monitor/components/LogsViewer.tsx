import { useState, useEffect, useRef } from "react";

type LogEntry = {
  id: string;
  level: "log" | "warn" | "error" | "info";
  timestamp: string;
  message: string;
};

type LogLevel = "all" | "log" | "warn" | "error" | "info";

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}

export function LogsViewer({
  logs,
}: {
  logs: LogEntry[] | null;
}) {
  const [filter, setFilter] = useState<LogLevel>("all");
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  const filtered = logs
    ? filter === "all"
      ? logs
      : logs.filter((l) => l.level === filter)
    : null;

  // Count by level
  const counts = {
    all: logs?.length ?? 0,
    log: logs?.filter((l) => l.level === "log").length ?? 0,
    warn: logs?.filter((l) => l.level === "warn").length ?? 0,
    error: logs?.filter((l) => l.level === "error").length ?? 0,
    info: logs?.filter((l) => l.level === "info").length ?? 0,
  };

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (autoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filtered?.length]);

  // Detect manual scroll
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  }

  if (!logs) {
    return (
      <div className="empty-state">
        <div className="spinner" />
        <div>Loading logs...</div>
      </div>
    );
  }

  const levels: LogLevel[] = ["all", "log", "info", "warn", "error"];

  return (
    <div className="logs-viewer">
      <div className="logs-filters">
        {levels.map((lvl) => (
          <button
            key={lvl}
            className={`log-filter-btn ${filter === lvl ? "active" : ""}`}
            onClick={() => setFilter(lvl)}
          >
            {lvl === "all" ? "All" : lvl.charAt(0).toUpperCase() + lvl.slice(1)}
            {counts[lvl] > 0 && (
              <span className="log-filter-badge">{counts[lvl]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="logs-scroll" ref={scrollRef} onScroll={handleScroll}>
        {filtered && filtered.length > 0 ? (
          filtered.map((entry) => (
            <div key={entry.id} className={`log-entry ${entry.level}`}>
              <span className="log-time">{formatTime(entry.timestamp)}</span>
              <span className="log-level">{entry.level}</span>
              {entry.message}
            </div>
          ))
        ) : (
          <div className="empty-state">
            <div>No logs yet</div>
            <div className="empty-hint">
              Server console output will appear here
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
