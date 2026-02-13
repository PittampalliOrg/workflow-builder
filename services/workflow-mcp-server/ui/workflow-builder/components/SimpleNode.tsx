import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";

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

export function SimpleNode({ data, selected }: NodeProps) {
  const nodeData = data as {
    label?: string;
    type?: string;
    config?: Record<string, unknown>;
    enabled?: boolean;
  };
  const nodeType = nodeData.type ?? "action";
  const color = TYPE_COLORS[nodeType] ?? "#6b7280";
  const label = nodeData.label || nodeType;
  const actionType = nodeData.config?.actionType as string | undefined;
  const disabled = nodeData.enabled === false;

  return (
    <div
      className={`simple-node ${selected ? "selected" : ""} ${disabled ? "disabled" : ""}`}
      style={{ borderLeftColor: color }}
    >
      <Handle type="target" position={Position.Top} className="node-handle" />
      <div className="node-type-badge" style={{ background: color }}>
        {nodeType}
      </div>
      <div className="node-label">{label}</div>
      {actionType && (
        <div className="node-action-type">{actionType}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="node-handle" />
    </div>
  );
}
