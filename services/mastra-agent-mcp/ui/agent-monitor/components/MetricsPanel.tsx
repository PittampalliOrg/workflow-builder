type AgentState = {
  totalRuns: number;
  totalTokens: number;
  toolNames: string[];
  lastError: string | null;
};

export function MetricsPanel({ state }: { state: AgentState | null }) {
  if (!state) return null;

  return (
    <div className="metrics-panel">
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-value">{state.totalRuns}</div>
          <div className="metric-label">Total Runs</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">
            {state.totalTokens > 1000
              ? `${(state.totalTokens / 1000).toFixed(1)}k`
              : state.totalTokens}
          </div>
          <div className="metric-label">Total Tokens</div>
        </div>
      </div>

      <div className="metric-section">
        <div className="metric-section-label">Available Tools</div>
        <div className="tool-chips">
          {state.toolNames.length > 0 ? (
            state.toolNames.map((name) => (
              <span key={name} className="tool-chip">
                {name}
              </span>
            ))
          ) : (
            <span className="metric-empty">No tools</span>
          )}
        </div>
      </div>

      {state.lastError && (
        <div className="metric-section">
          <div className="metric-section-label">Last Error</div>
          <div className="error-box">{state.lastError}</div>
        </div>
      )}
    </div>
  );
}
