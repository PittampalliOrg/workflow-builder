import { useState, useEffect } from "react";
import type { WorkflowApi } from "../hooks/useWorkflowApi";
import type { NodeData } from "../App";

interface Props {
  api: WorkflowApi;
  workflowId: string;
  node: NodeData;
  onClose: () => void;
  onUpdate: () => void;
  showToast: (msg: string, type?: "success" | "error") => void;
}

const TYPE_COLORS: Record<string, string> = {
  trigger: "#22c55e",
  action: "#3b82f6",
  activity: "#8b5cf6",
  "approval-gate": "#f59e0b",
  timer: "#a855f7",
  "loop-until": "#06b6d4",
  "if-else": "#ec4899",
  note: "#6b7280",
  "set-state": "#14b8a6",
  transform: "#f97316",
  "publish-event": "#ef4444",
};

export function NodeDetail({ api, workflowId, node, onClose, onUpdate, showToast }: Props) {
  const [label, setLabel] = useState(node.data.label);
  const [description, setDescription] = useState(node.data.description ?? "");
  const [enabled, setEnabled] = useState(node.data.enabled !== false);
  const [actionType, setActionType] = useState(
    (node.data.config?.actionType as string) ?? "",
  );
  const [durationSeconds, setDurationSeconds] = useState(
    (node.data.config?.durationSeconds as number) ?? 60,
  );
  const [eventName, setEventName] = useState(
    (node.data.config?.eventName as string) ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setLabel(node.data.label);
    setDescription(node.data.description ?? "");
    setEnabled(node.data.enabled !== false);
    setActionType((node.data.config?.actionType as string) ?? "");
    setDurationSeconds((node.data.config?.durationSeconds as number) ?? 60);
    setEventName((node.data.config?.eventName as string) ?? "");
    setConfirmDelete(false);
  }, [node]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates: Record<string, unknown> = {
        label,
        description,
        enabled,
      };
      if (node.data.type === "action" && actionType) {
        updates.config = { actionType };
      }
      if (node.data.type === "timer") {
        updates.config = { durationSeconds };
      }
      if (node.data.type === "approval-gate") {
        updates.config = { eventName };
      }
      await api.updateNode(workflowId, node.id, updates);
      onUpdate();
    } catch {
      showToast("Failed to save", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    setDeleting(true);
    try {
      await api.deleteNode(workflowId, node.id);
      showToast("Node deleted");
      onClose();
    } catch {
      showToast("Failed to delete node", "error");
    } finally {
      setDeleting(false);
    }
  };

  const color = TYPE_COLORS[node.data.type] ?? "#6b7280";

  return (
    <div className="node-detail">
      <div className="nd-header">
        <button className="btn-icon" onClick={onClose} title="Back to graph">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="nd-title">
          <span className="nd-type-badge" style={{ background: color }}>
            {node.data.type}
          </span>
          <span className="nd-node-label">{node.data.label || node.data.type}</span>
        </div>
      </div>

      <div className="nd-body">
        <div className="field">
          <label htmlFor="nd-label">Label</label>
          <input
            id="nd-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Node label..."
          />
        </div>

        <div className="field">
          <label htmlFor="nd-desc">Description</label>
          <textarea
            id="nd-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Optional description..."
          />
        </div>

        {node.data.type === "action" && (
          <div className="field">
            <label htmlFor="nd-action-type">Action Type</label>
            <input
              id="nd-action-type"
              type="text"
              placeholder="e.g. openai/generate-text"
              value={actionType}
              onChange={(e) => setActionType(e.target.value)}
            />
            <span className="field-hint">
              Ask the AI to list_available_actions
            </span>
          </div>
        )}

        {node.data.type === "timer" && (
          <div className="field">
            <label htmlFor="nd-duration">Duration (seconds)</label>
            <input
              id="nd-duration"
              type="number"
              min={1}
              value={durationSeconds}
              onChange={(e) => setDurationSeconds(parseInt(e.target.value) || 60)}
            />
          </div>
        )}

        {node.data.type === "approval-gate" && (
          <div className="field">
            <label htmlFor="nd-event">Event Name</label>
            <input
              id="nd-event"
              type="text"
              value={eventName}
              onChange={(e) => setEventName(e.target.value)}
              placeholder="e.g. plan-approval"
            />
          </div>
        )}

        <div className="field field-row">
          <input
            id="nd-enabled"
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <label htmlFor="nd-enabled">Enabled</label>
        </div>

        <div className="field">
          <label>Position</label>
          <div className="nd-position">
            x: {Math.round(node.position.x)}, y: {Math.round(node.position.y)}
          </div>
        </div>

        {node.data.config && Object.keys(node.data.config).length > 0 && (
          <div className="field">
            <label>Config</label>
            <pre className="config-preview">
              {JSON.stringify(node.data.config, null, 2)}
            </pre>
          </div>
        )}
      </div>

      <div className="nd-actions">
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
          style={{ flex: 1 }}
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
        <button
          className={`btn-danger ${confirmDelete ? "confirm" : ""}`}
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting
            ? "..."
            : confirmDelete
              ? "Confirm?"
              : "Delete"}
        </button>
      </div>
    </div>
  );
}
