import { useState, useRef, useEffect, useCallback } from "react";
import type { WorkflowApi } from "../hooks/useWorkflowApi";
import type { Workflow } from "../App";

const NODE_TYPES = [
  { value: "action", label: "Action" },
  { value: "approval-gate", label: "Approval Gate" },
  { value: "timer", label: "Timer" },
  { value: "if-else", label: "If/Else" },
  { value: "loop-until", label: "Loop Until" },
  { value: "set-state", label: "Set State" },
  { value: "transform", label: "Transform" },
  { value: "publish-event", label: "Publish Event" },
  { value: "note", label: "Note" },
];

interface Props {
  api: WorkflowApi;
  workflow: Workflow | null;
  onRefresh: () => void;
  onWorkflowDeleted: () => void;
  onBackToList: () => void;
  showToast: (msg: string, type?: "success" | "error") => void;
}

export function GraphToolbar({
  api,
  workflow,
  onRefresh,
  onWorkflowDeleted,
  onBackToList,
  showToast,
}: Props) {
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState("");
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [executionInstanceId, setExecutionInstanceId] = useState<string | null>(null);
  const [executionStatus, setExecutionStatus] = useState<any>(null);
  const [approving, setApproving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const handleNameClick = () => {
    if (!workflow) return;
    setName(workflow.name);
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const handleNameBlur = async () => {
    setEditingName(false);
    if (!workflow || !name.trim() || name === workflow.name) return;
    try {
      await api.updateWorkflow(workflow.id, { name: name.trim() });
      onRefresh();
      showToast("Renamed");
    } catch {
      showToast("Failed to rename", "error");
    }
  };

  const handleAddNode = async (type: string) => {
    if (!workflow) return;
    setShowAddMenu(false);
    try {
      const maxY = workflow.nodes.reduce(
        (max, n) => Math.max(max, n.position.y),
        0,
      );
      await api.addNode(
        workflow.id,
        type,
        type.charAt(0).toUpperCase() + type.slice(1).replace(/-/g, " "),
        200,
        maxY + 120,
      );
      onRefresh();
      showToast(`Added ${type} node`);
    } catch {
      showToast("Failed to add node", "error");
    }
  };

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (instanceId: string) => {
      stopPolling();
      const poll = async () => {
        try {
          const status = await api.getExecutionStatus(instanceId);
          setExecutionStatus(status);
          const s = status?.runtimeStatus ?? status?.status;
          if (
            s === "COMPLETED" ||
            s === "completed" ||
            s === "FAILED" ||
            s === "failed" ||
            s === "TERMINATED" ||
            s === "terminated"
          ) {
            stopPolling();
          }
        } catch {
          // keep polling on transient errors
        }
      };
      poll();
      pollRef.current = setInterval(poll, 3000);
    },
    [api, stopPolling],
  );

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  const handleRun = async () => {
    if (!workflow || executing) return;
    setExecuting(true);
    setExecutionStatus(null);
    setExecutionInstanceId(null);
    try {
      const result = await api.executeWorkflow(workflow.id);
      const instanceId = result?.instanceId ?? result?.instance_id;
      if (instanceId) {
        setExecutionInstanceId(instanceId);
        startPolling(instanceId);
        showToast("Workflow started");
      } else {
        showToast("Workflow started (no instance ID)");
      }
    } catch {
      showToast("Failed to execute", "error");
    } finally {
      setExecuting(false);
    }
  };

  const handleApprove = async (approved: boolean) => {
    if (!executionInstanceId || !executionStatus?.approvalEventName || approving)
      return;
    setApproving(true);
    try {
      await api.approveWorkflow(
        executionInstanceId,
        executionStatus.approvalEventName,
        approved,
      );
      showToast(approved ? "Approved" : "Rejected");
    } catch {
      showToast("Failed to send approval", "error");
    } finally {
      setApproving(false);
    }
  };

  const handleResetExecution = () => {
    stopPolling();
    setExecutionInstanceId(null);
    setExecutionStatus(null);
  };

  const runtimeStatus =
    executionStatus?.runtimeStatus ?? executionStatus?.status;
  const isTerminal =
    runtimeStatus === "COMPLETED" ||
    runtimeStatus === "completed" ||
    runtimeStatus === "FAILED" ||
    runtimeStatus === "failed" ||
    runtimeStatus === "TERMINATED" ||
    runtimeStatus === "terminated";
  const isAwaitingApproval =
    !!executionStatus?.approvalEventName && !isTerminal;

  const handleDuplicate = async () => {
    if (!workflow) return;
    try {
      await api.duplicateWorkflow(workflow.id);
      onRefresh();
      showToast("Duplicated");
    } catch {
      showToast("Failed to duplicate", "error");
    }
  };

  const handleDelete = async () => {
    if (!workflow) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
      return;
    }
    try {
      await api.deleteWorkflow(workflow.id);
      onWorkflowDeleted();
    } catch {
      showToast("Failed to delete", "error");
    }
  };

  if (!workflow) return null;

  return (
    <>
      <div className="graph-toolbar">
        <div className="gt-left">
          <button
            className="btn-icon"
            onClick={onBackToList}
            title="Back to list"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M10 4l-4 4 4 4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {editingName ? (
            <input
              ref={nameInputRef}
              className="gt-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleNameBlur}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleNameBlur();
                if (e.key === "Escape") setEditingName(false);
              }}
            />
          ) : (
            <span
              className="gt-name"
              onClick={handleNameClick}
              title="Click to rename"
            >
              {workflow.name}
            </span>
          )}
        </div>

        <div className="gt-right">
          <div className="add-node-wrapper">
            <button
              className="btn-sm btn-secondary"
              onClick={() => setShowAddMenu(!showAddMenu)}
            >
              + Node
            </button>
            {showAddMenu && (
              <div className="add-node-menu">
                {NODE_TYPES.map((t) => (
                  <button
                    key={t.value}
                    className="add-node-option"
                    onClick={() => handleAddNode(t.value)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          {executionInstanceId && !isTerminal ? (
            <span
              className="execution-phase"
              title={`Instance: ${executionInstanceId}`}
            >
              {executionStatus?.phase ?? runtimeStatus ?? "running"}
            </span>
          ) : isTerminal ? (
            <button
              className="btn-sm btn-secondary"
              onClick={handleResetExecution}
              title="Clear and re-run"
            >
              {runtimeStatus?.toLowerCase() === "completed"
                ? "Done"
                : "Failed"}{" "}
              — Reset
            </button>
          ) : (
            <button
              className="btn-primary btn-sm"
              onClick={handleRun}
              disabled={executing}
              title="Execute workflow"
            >
              {executing ? "..." : "Run"}
            </button>
          )}
          <button
            className="btn-icon"
            onClick={handleDuplicate}
            title="Duplicate"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect
                x="5"
                y="5"
                width="9"
                height="9"
                rx="1.5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
              <path
                d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </button>
          <button
            className={`btn-icon ${confirmDelete ? "btn-icon-danger" : ""}`}
            onClick={handleDelete}
            title={confirmDelete ? "Click again to confirm" : "Delete workflow"}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6 7v4M10 7v4M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
      {isAwaitingApproval && (
        <div className="approval-bar">
          <span className="approval-text">
            Awaiting approval:{" "}
            <strong>{executionStatus.approvalEventName}</strong>
          </span>
          <div className="approval-actions">
            <button
              className="btn-sm btn-approve"
              onClick={() => handleApprove(true)}
              disabled={approving}
            >
              {approving ? "..." : "Approve"}
            </button>
            <button
              className="btn-sm btn-reject"
              onClick={() => handleApprove(false)}
              disabled={approving}
            >
              {approving ? "..." : "Reject"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
