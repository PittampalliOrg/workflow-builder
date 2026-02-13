type WorkflowContextData = {
  workflowId: string | null;
  nodeId: string | null;
  stepIndex: number | null;
  receivedEvents: number;
};

export function WorkflowContext({
  context,
}: {
  context: WorkflowContextData | null;
}) {
  if (!context) return null;

  const hasContext = context.workflowId || context.nodeId || context.receivedEvents > 0;

  if (!hasContext) {
    return (
      <div className="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
          <polyline points="13 2 13 9 20 9" />
        </svg>
        <span>Not part of a workflow</span>
        <span className="empty-hint">
          Dapr workflow context will appear here when the agent runs inside a
          workflow
        </span>
      </div>
    );
  }

  return (
    <div className="workflow-context">
      <div className="wc-field">
        <span className="wc-label">Workflow ID</span>
        <code className="wc-value">{context.workflowId ?? "—"}</code>
      </div>
      <div className="wc-field">
        <span className="wc-label">Node ID</span>
        <code className="wc-value">{context.nodeId ?? "—"}</code>
      </div>
      <div className="wc-field">
        <span className="wc-label">Step Index</span>
        <code className="wc-value">
          {context.stepIndex !== null ? context.stepIndex : "—"}
        </code>
      </div>
      <div className="wc-field">
        <span className="wc-label">Received Events</span>
        <code className="wc-value">{context.receivedEvents}</code>
      </div>
    </div>
  );
}
