type AgentState = {
  status: "idle" | "running" | "error";
  currentActivity: string | null;
  runId: string | null;
  startedAt: string | null;
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

export function StatusIndicator({ state }: { state: AgentState | null }) {
  if (!state) {
    return <div className="status-indicator">Loading...</div>;
  }

  const dotClass =
    state.status === "running"
      ? "status-dot running"
      : state.status === "error"
        ? "status-dot error"
        : "status-dot idle";

  return (
    <div className="status-indicator">
      <div className="status-header">
        <span className={dotClass} />
        <span className="status-label">
          {state.status === "running"
            ? "Running"
            : state.status === "error"
              ? "Error"
              : "Idle"}
        </span>
      </div>
      {state.currentActivity && (
        <div className="status-activity">{state.currentActivity}</div>
      )}
      {state.runId && (
        <div className="status-meta">
          Run: <code>{state.runId.slice(0, 8)}</code>
          {state.startedAt && (
            <span> &middot; started {relativeTime(state.startedAt)}</span>
          )}
        </div>
      )}
    </div>
  );
}
