import { useState, useEffect } from "react";
import type { WorkflowApi } from "../hooks/useWorkflowApi";
import type { WorkflowSummary } from "../App";

interface Props {
  api: WorkflowApi;
  selectedId: string | null;
  onSelect: (wf: WorkflowSummary) => void;
  refreshKey: number;
  showToast: (msg: string, type?: "success" | "error") => void;
}

export function WorkflowList({ api, selectedId, onSelect, refreshKey, showToast }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listWorkflows()
      .then((data) => {
        if (cancelled) return;
        setWorkflows(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [api, refreshKey]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const wf = await api.createWorkflow(name);
      setNewName("");
      showToast(`Created "${name}"`);
      if (wf) onSelect(wf);
      const data = await api.listWorkflows();
      setWorkflows(Array.isArray(data) ? data : []);
    } catch {
      showToast("Failed to create workflow", "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="workflow-list">
      <div className="wl-header">
        <h2>Workflows</h2>
        <span className="wl-count">{workflows.length}</span>
      </div>

      <div className="wl-create">
        <input
          type="text"
          placeholder="New workflow name..."
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          disabled={creating}
        />
        <button
          className="btn-primary btn-sm"
          onClick={handleCreate}
          disabled={!newName.trim() || creating}
        >
          {creating ? "..." : "Create"}
        </button>
      </div>

      <div className="wl-items">
        {loading ? (
          <div className="loading-container">
            <div className="spinner" />
          </div>
        ) : workflows.length === 0 ? (
          <div className="empty-state">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <rect x="4" y="5" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="18" y="5" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <rect x="11" y="20" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M9 12v3l7 5M23 12v3l-7 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <p>No workflows yet</p>
            <p className="empty-hint">Create one above or ask the AI to help</p>
          </div>
        ) : (
          <ul className="list-items">
            {workflows.map((wf) => (
              <li
                key={wf.id}
                className={`wl-item ${selectedId === wf.id ? "selected" : ""}`}
                onClick={() => onSelect(wf)}
              >
                <div className="wl-item-main">
                  <span className="wl-item-name">{wf.name}</span>
                  <span className="wl-item-desc">
                    {wf.description || "No description"}
                  </span>
                </div>
                <div className="wl-item-meta">
                  <span className="badge badge-default">
                    {wf.node_count} node{wf.node_count !== 1 ? "s" : ""}
                  </span>
                  <span className="badge badge-default">
                    {wf.edge_count} edge{wf.edge_count !== 1 ? "s" : ""}
                  </span>
                </div>
                <svg className="wl-item-arrow" width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
