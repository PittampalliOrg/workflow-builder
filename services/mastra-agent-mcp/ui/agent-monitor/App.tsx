import { useState, useEffect, useCallback } from "react";
import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import type { App as McpApp } from "@modelcontextprotocol/ext-apps";
import { useAgentApi } from "./hooks/useAgentApi";
import { StatusIndicator } from "./components/StatusIndicator";
import { MetricsPanel } from "./components/MetricsPanel";
import { EventTimeline } from "./components/EventTimeline";
import { WorkflowContext } from "./components/WorkflowContext";

type Tab = "status" | "events" | "workflow";

export default function App() {
  const { app } = useApp({
    appInfo: { name: "Mastra Agent Monitor", version: "1.0.0" },
    onAppCreated: (newApp: McpApp) => {
      newApp.ontoolinput = () => {};
      newApp.ontoolresult = () => {
        // Bump refresh on any tool result from the host
        setRefreshKey((k) => k + 1);
      };
    },
  });
  useHostStyles(app);

  const api = useAgentApi(app);

  const [activeTab, setActiveTab] = useState<Tab>("status");
  const [refreshKey, setRefreshKey] = useState(0);

  const [agentState, setAgentState] = useState<Record<string, unknown> | null>(
    null,
  );
  const [events, setEvents] = useState<Array<Record<string, unknown>> | null>(
    null,
  );
  const [workflowCtx, setWorkflowCtx] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [eventCount, setEventCount] = useState(0);

  const poll = useCallback(async () => {
    if (!app) return;
    try {
      const [status, evts, wfCtx] = await Promise.all([
        api.getAgentStatus(),
        api.getEventHistory(100),
        api.getWorkflowContext(),
      ]);
      setAgentState(status);
      setEvents(evts);
      setWorkflowCtx(wfCtx);
      if (Array.isArray(evts)) {
        setEventCount(evts.length);
      }
    } catch {
      // ignore poll errors
    }
  }, [app, api]);

  // Poll every 2 seconds
  useEffect(() => {
    if (!app) return;
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [app, poll, refreshKey]);

  return (
    <div className="agent-app">
      {/* Tab bar */}
      <div className="tab-bar">
        <button
          className={`tab-btn ${activeTab === "status" ? "active" : ""}`}
          onClick={() => setActiveTab("status")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="8" cy="8" r="6" />
            <path d="M8 5v3l2 2" strokeLinecap="round" />
          </svg>
          Status
        </button>
        <button
          className={`tab-btn ${activeTab === "events" ? "active" : ""}`}
          onClick={() => setActiveTab("events")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path
              d="M2 4h12M2 8h12M2 12h8"
              strokeLinecap="round"
            />
          </svg>
          Events
          {eventCount > 0 && (
            <span className="tab-badge">{eventCount}</span>
          )}
        </button>
        <button
          className={`tab-btn ${activeTab === "workflow" ? "active" : ""}`}
          onClick={() => setActiveTab("workflow")}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="1" y="2" width="5" height="4" rx="1" />
            <rect x="10" y="2" width="5" height="4" rx="1" />
            <rect x="5.5" y="10" width="5" height="4" rx="1" />
            <path
              d="M3.5 6v2l4.5 2M12.5 6v2l-4.5 2"
              strokeLinecap="round"
            />
          </svg>
          Workflow
        </button>
      </div>

      {/* Tab content */}
      <div className="tab-content">
        {activeTab === "status" && (
          <div className="status-tab">
            <StatusIndicator state={agentState as any} />
            <MetricsPanel state={agentState as any} />
          </div>
        )}

        {activeTab === "events" && (
          <EventTimeline events={events as any} />
        )}

        {activeTab === "workflow" && (
          <WorkflowContext context={workflowCtx as any} />
        )}
      </div>
    </div>
  );
}
