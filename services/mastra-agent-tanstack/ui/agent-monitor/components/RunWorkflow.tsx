import { useState, useEffect, useRef } from "react";
import type { AgentApi } from "../hooks/useAgentApi";

type WorkflowStatus = {
  instanceId: string;
  workflowId: string;
  runtimeStatus: string;
  phase?: string;
  progress?: number;
  message?: string;
  currentNodeId?: string;
  currentNodeName?: string;
  approvalEventName?: string;
  error?: string;
};

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "TERMINATED"];

export function RunWorkflow({ api }: { api: AgentApi }) {
  const [prompt, setPrompt] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoName, setRepoName] = useState("");
  const [branch, setBranch] = useState("main");
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const pollStatus = (instanceId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await api.getWorkflowExecutionStatus(instanceId);
        setStatus(s);
        if (TERMINAL_STATUSES.includes(s.runtimeStatus)) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } catch {
        // ignore poll errors
      }
    }, 2000);
  };

  const handleRun = async () => {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError(null);
    setStatus(null);

    try {
      const result = await api.runWorkflow({
        workflowId: "yptntuid5sk3cqjymg8kw",
        prompt: prompt.trim(),
        ...(repoOwner && { repo_owner: repoOwner }),
        ...(repoName && { repo_name: repoName }),
        ...(branch && branch !== "main" && { branch }),
      });

      if (!result || !result.instanceId) {
        setError("No response from workflow service. Check that the orchestrator is running.");
        return;
      }

      setStatus({
        instanceId: result.instanceId,
        workflowId: result.workflowId,
        runtimeStatus: "PENDING",
      });

      pollStatus(result.instanceId);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproval = async (approved: boolean) => {
    if (!status?.instanceId || !status?.approvalEventName) return;
    setApproving(true);
    setError(null);
    try {
      await api.approveWorkflow({
        instanceId: status.instanceId,
        eventName: status.approvalEventName,
        approved,
        reason: approved ? "Approved from MCP App" : "Rejected from MCP App",
      });
    } catch (err) {
      setError(String(err));
    } finally {
      setApproving(false);
    }
  };

  const statusDotClass = () => {
    if (!status) return "";
    if (status.phase === "awaiting_approval") return "approval";
    switch (status.runtimeStatus) {
      case "RUNNING":
      case "PENDING":
        return "running";
      case "COMPLETED":
        return "idle";
      case "FAILED":
      case "TERMINATED":
        return "error";
      default:
        return "";
    }
  };

  const isAwaitingApproval = status?.phase === "awaiting_approval" && status?.approvalEventName;

  return (
    <div className="run-form">
      <div className="wc-field">
        <label className="wc-label">Prompt *</label>
        <textarea
          className="wc-input wc-textarea"
          placeholder="Describe what you want the workflow to do..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          disabled={submitting}
        />
      </div>

      <div className="wc-field">
        <label className="wc-label">Repo Owner</label>
        <input
          className="wc-input"
          type="text"
          placeholder="e.g. PittampalliOrg"
          value={repoOwner}
          onChange={(e) => setRepoOwner(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div className="wc-field">
        <label className="wc-label">Repo Name</label>
        <input
          className="wc-input"
          type="text"
          placeholder="e.g. workflow-builder"
          value={repoName}
          onChange={(e) => setRepoName(e.target.value)}
          disabled={submitting}
        />
      </div>

      <div className="wc-field">
        <label className="wc-label">Branch</label>
        <input
          className="wc-input"
          type="text"
          placeholder="main"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          disabled={submitting}
        />
      </div>

      <button
        className="run-btn"
        onClick={handleRun}
        disabled={submitting || !prompt.trim()}
      >
        {submitting ? (
          <>
            <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
            Starting...
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2l10 6-10 6V2z" />
            </svg>
            Run Workflow
          </>
        )}
      </button>

      {error && <div className="error-box">{error}</div>}

      {status && (
        <div className={`run-status ${isAwaitingApproval ? "run-status--approval" : ""}`}>
          <div className="run-status-header">
            <span className={`status-dot ${statusDotClass()}`} />
            <span className="status-label">
              {isAwaitingApproval ? "Awaiting Approval" : status.runtimeStatus}
            </span>
          </div>

          {isAwaitingApproval && (
            <div className="approval-box">
              <div className="approval-message">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#d97706" strokeWidth="1.5">
                  <path d="M8 1l7 13H1L8 1z" strokeLinejoin="round" />
                  <path d="M8 6v3M8 11.5v.5" strokeLinecap="round" />
                </svg>
                <span>Plan review required</span>
              </div>
              <div className="approval-actions">
                <button
                  className="approval-btn approval-btn--reject"
                  onClick={() => handleApproval(false)}
                  disabled={approving}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                  </svg>
                  Reject
                </button>
                <button
                  className="approval-btn approval-btn--approve"
                  onClick={() => handleApproval(true)}
                  disabled={approving}
                >
                  {approving ? (
                    <span className="spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 8l4 4 6-8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                  Approve
                </button>
              </div>
            </div>
          )}

          <div className="wc-field">
            <span className="wc-label">Instance ID</span>
            <span className="wc-value" style={{ fontSize: 10 }}>{status.instanceId}</span>
          </div>

          {status.phase && (
            <div className="wc-field">
              <span className="wc-label">Phase</span>
              <span className="wc-value">{status.phase}</span>
            </div>
          )}

          {status.currentNodeName && (
            <div className="wc-field">
              <span className="wc-label">Current Node</span>
              <span className="wc-value">{status.currentNodeName}</span>
            </div>
          )}

          {typeof status.progress === "number" && status.progress > 0 && (
            <div className="wc-field">
              <span className="wc-label">Progress</span>
              <div className="run-progress-bar">
                <div className="run-progress-fill" style={{ width: `${status.progress}%` }} />
              </div>
            </div>
          )}

          {status.message && (
            <div className="wc-field">
              <span className="wc-label">Message</span>
              <span className="wc-value">{status.message}</span>
            </div>
          )}

          {status.error && <div className="error-box">{status.error}</div>}
        </div>
      )}
    </div>
  );
}
