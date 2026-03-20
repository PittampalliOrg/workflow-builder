import { jsx, jsxs } from 'react/jsx-runtime';
import { useState, useCallback, useEffect } from 'react';
import { R as Route, g as getAgentStatus, a as getEventHistory, b as getWorkflowContext } from './router-DAD18Eue.mjs';
import '@tanstack/react-router';
import '../virtual/entry.mjs';
import '@opentelemetry/auto-instrumentations-node';
import '@opentelemetry/exporter-metrics-otlp-http';
import '@opentelemetry/exporter-trace-otlp-http';
import '@opentelemetry/resources';
import '@opentelemetry/sdk-metrics';
import '@opentelemetry/sdk-node';
import 'node:events';
import 'nanoid';
import '@mastra/core/agent';
import '@mastra/core/workspace';
import '@ai-sdk/openai';
import 'node:https';
import 'node:fs';
import 'node:path';
import '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import '@modelcontextprotocol/sdk/types.js';
import '@modelcontextprotocol/sdk/server/mcp.js';
import '@modelcontextprotocol/ext-apps/server';
import '@tanstack/history';
import '@tanstack/router-core/ssr/client';
import '@tanstack/router-core';
import 'node:async_hooks';
import '@tanstack/router-core/ssr/server';
import 'rou3';
import 'srvx';
import 'tiny-invariant';
import 'seroval';
import '@tanstack/react-router/ssr/server';

function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1e3);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}
function StatusIndicator({ state }) {
  if (!state) {
    return /* @__PURE__ */ jsx("div", { style: { padding: 12, color: "#999" }, children: "Loading..." });
  }
  const dotColor = state.status === "running" ? "#f59e0b" : state.status === "error" ? "#ef4444" : "#10b981";
  return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600 }, children: [
      /* @__PURE__ */ jsx(
        "span",
        {
          style: {
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: dotColor,
            display: "inline-block",
            flexShrink: 0
          }
        }
      ),
      /* @__PURE__ */ jsx("span", { style: { textTransform: "capitalize" }, children: state.status })
    ] }),
    state.currentActivity && /* @__PURE__ */ jsx("div", { style: { fontSize: 12, color: "#666", paddingLeft: 18 }, children: state.currentActivity }),
    state.runId && /* @__PURE__ */ jsxs("div", { style: { fontSize: 11, color: "#999", paddingLeft: 18 }, children: [
      "Run: ",
      /* @__PURE__ */ jsx("code", { style: { fontFamily: "monospace", background: "#eee", padding: "1px 4px", borderRadius: 3, fontSize: 10 }, children: state.runId.slice(0, 8) }),
      state.startedAt && /* @__PURE__ */ jsxs("span", { children: [
        " \xB7 started ",
        relativeTime(state.startedAt)
      ] })
    ] })
  ] });
}
function MetricsPanel({ state }) {
  if (!state) return null;
  return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 12 }, children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }, children: [
      /* @__PURE__ */ jsxs("div", { style: cardStyle, children: [
        /* @__PURE__ */ jsx("div", { style: valueStyle, children: state.totalRuns }),
        /* @__PURE__ */ jsx("div", { style: labelStyle, children: "Total Runs" })
      ] }),
      /* @__PURE__ */ jsxs("div", { style: cardStyle, children: [
        /* @__PURE__ */ jsx("div", { style: valueStyle, children: state.totalTokens > 1e3 ? `${(state.totalTokens / 1e3).toFixed(1)}k` : state.totalTokens }),
        /* @__PURE__ */ jsx("div", { style: labelStyle, children: "Total Tokens" })
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("div", { style: sectionLabelStyle, children: "Available Tools" }),
      /* @__PURE__ */ jsx("div", { style: { display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }, children: state.toolNames.length > 0 ? state.toolNames.map((name) => /* @__PURE__ */ jsx("span", { style: chipStyle, children: name }, name)) : /* @__PURE__ */ jsx("span", { style: { fontSize: 11, color: "#999" }, children: "No tools" }) })
    ] }),
    state.lastError && /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("div", { style: sectionLabelStyle, children: "Last Error" }),
      /* @__PURE__ */ jsx("div", { style: {
        background: "#fef2f2",
        border: "1px solid #fecaca",
        borderRadius: 4,
        padding: 8,
        fontSize: 11,
        color: "#dc2626",
        fontFamily: "monospace",
        wordBreak: "break-word",
        marginTop: 4
      }, children: state.lastError })
    ] })
  ] });
}
const cardStyle = {
  background: "#f9f9f9",
  border: "1px solid #e5e5e5",
  borderRadius: 8,
  padding: 12,
  textAlign: "center"
};
const valueStyle = {
  fontSize: 22,
  fontWeight: 700,
  color: "#0078d4"
};
const labelStyle = {
  fontSize: 11,
  color: "#666",
  marginTop: 2
};
const sectionLabelStyle = {
  fontSize: 11,
  fontWeight: 500,
  color: "#666"
};
const chipStyle = {
  fontSize: 11,
  background: "#eee",
  padding: "2px 8px",
  borderRadius: 10,
  fontFamily: "monospace"
};
const TYPE_COLORS = {
  agent_started: "#8b5cf6",
  agent_completed: "#8b5cf6",
  tool_call: "#10b981",
  tool_result: "#10b981",
  llm_start: "#3b82f6",
  llm_end: "#3b82f6",
  dapr_event: "#6b7280"
};
function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
function EventItem({ event }) {
  const [expanded, setExpanded] = useState(false);
  const color = TYPE_COLORS[event.type] ?? "#6b7280";
  return /* @__PURE__ */ jsxs(
    "div",
    {
      onClick: () => setExpanded(!expanded),
      style: {
        padding: "8px 14px",
        borderBottom: "1px solid #e5e5e5",
        cursor: "pointer"
      },
      children: [
        /* @__PURE__ */ jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
          /* @__PURE__ */ jsx("span", { style: { fontSize: 10, fontFamily: "monospace", color: "#999", flexShrink: 0 }, children: formatTime(event.timestamp) }),
          /* @__PURE__ */ jsx(
            "span",
            {
              style: {
                fontSize: 9,
                fontWeight: 600,
                color: "#fff",
                padding: "1px 6px",
                borderRadius: 3,
                textTransform: "uppercase",
                letterSpacing: 0.3,
                whiteSpace: "nowrap",
                background: color
              },
              children: event.type.replace(/_/g, " ")
            }
          ),
          event.callId && /* @__PURE__ */ jsx("span", { style: { fontSize: 9, fontFamily: "monospace", color: "#999", background: "#eee", padding: "1px 4px", borderRadius: 3 }, children: event.callId }),
          /* @__PURE__ */ jsx("span", { style: { marginLeft: "auto", fontSize: 9, color: "#999" }, children: expanded ? "\u25BC" : "\u25B6" })
        ] }),
        expanded && /* @__PURE__ */ jsx(
          "pre",
          {
            style: {
              marginTop: 6,
              fontSize: 10,
              fontFamily: "monospace",
              background: "#f5f5f5",
              border: "1px solid #e5e5e5",
              borderRadius: 4,
              padding: 8,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 200,
              overflowY: "auto"
            },
            children: JSON.stringify(event.data, null, 2)
          }
        )
      ]
    }
  );
}
function EventTimeline({ events }) {
  if (!events || events.length === 0) {
    return /* @__PURE__ */ jsxs("div", { style: { padding: "32px 16px", color: "#999", textAlign: "center", fontSize: 13 }, children: [
      /* @__PURE__ */ jsx("div", { children: "No events yet" }),
      /* @__PURE__ */ jsx("div", { style: { fontSize: 11, marginTop: 4 }, children: "Run the agent to see events appear here" })
    ] });
  }
  return /* @__PURE__ */ jsx("div", { children: events.map((event) => /* @__PURE__ */ jsx(EventItem, { event }, event.id)) });
}
function WorkflowContext({
  context
}) {
  if (!context) return null;
  const hasContext = context.workflowId || context.nodeId || context.receivedEvents > 0;
  if (!hasContext) {
    return /* @__PURE__ */ jsxs("div", { style: { padding: "32px 16px", color: "#999", textAlign: "center", fontSize: 13, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }, children: [
      /* @__PURE__ */ jsxs("svg", { width: "32", height: "32", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.5", children: [
        /* @__PURE__ */ jsx("path", { d: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" }),
        /* @__PURE__ */ jsx("polyline", { points: "13 2 13 9 20 9" })
      ] }),
      /* @__PURE__ */ jsx("span", { children: "Not part of a workflow" }),
      /* @__PURE__ */ jsx("span", { style: { fontSize: 11 }, children: "Dapr workflow context will appear here when the agent runs inside a workflow" })
    ] });
  }
  return /* @__PURE__ */ jsxs("div", { style: { padding: 14, display: "flex", flexDirection: "column", gap: 12 }, children: [
    /* @__PURE__ */ jsx(Field, { label: "Workflow ID", value: context.workflowId ?? "\u2014" }),
    /* @__PURE__ */ jsx(Field, { label: "Node ID", value: context.nodeId ?? "\u2014" }),
    /* @__PURE__ */ jsx(
      Field,
      {
        label: "Step Index",
        value: context.stepIndex !== null ? String(context.stepIndex) : "\u2014"
      }
    ),
    /* @__PURE__ */ jsx(Field, { label: "Received Events", value: String(context.receivedEvents) })
  ] });
}
function Field({ label, value }) {
  return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 2 }, children: [
    /* @__PURE__ */ jsx("span", { style: { fontSize: 11, fontWeight: 500, color: "#666" }, children: label }),
    /* @__PURE__ */ jsx(
      "code",
      {
        style: {
          fontFamily: "monospace",
          fontSize: 12,
          background: "#f5f5f5",
          border: "1px solid #e5e5e5",
          borderRadius: 4,
          padding: "6px 10px",
          wordBreak: "break-all"
        },
        children: value
      }
    )
  ] });
}
function Dashboard({ initialState, initialEvents, initialWorkflow }) {
  const [activeTab, setActiveTab] = useState("status");
  const [agentState, setAgentState] = useState(initialState);
  const [events, setEvents] = useState(initialEvents);
  const [workflowCtx, setWorkflowCtx] = useState(initialWorkflow);
  const poll = useCallback(async () => {
    try {
      const [status, evts, wfCtx] = await Promise.all([
        getAgentStatus(),
        getEventHistory(),
        getWorkflowContext()
      ]);
      setAgentState(status);
      setEvents(evts);
      setWorkflowCtx(wfCtx);
    } catch {
    }
  }, []);
  useEffect(() => {
    const interval = setInterval(poll, 2e3);
    return () => clearInterval(interval);
  }, [poll]);
  const eventCount = Array.isArray(events) ? events.length : 0;
  return /* @__PURE__ */ jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", fontSize: 13 }, children: [
    /* @__PURE__ */ jsxs("div", { style: { display: "flex", borderBottom: "1px solid #e5e5e5", background: "#f9f9f9", flexShrink: 0 }, children: [
      /* @__PURE__ */ jsx(TabBtn, { active: activeTab === "status", onClick: () => setActiveTab("status"), children: "Status" }),
      /* @__PURE__ */ jsxs(TabBtn, { active: activeTab === "events", onClick: () => setActiveTab("events"), children: [
        "Events",
        eventCount > 0 && /* @__PURE__ */ jsx("span", { style: { fontSize: 10, background: "#0078d4", color: "#fff", padding: "0 5px", borderRadius: 8, minWidth: 18, textAlign: "center", lineHeight: "16px", marginLeft: 4 }, children: eventCount })
      ] }),
      /* @__PURE__ */ jsx(TabBtn, { active: activeTab === "workflow", onClick: () => setActiveTab("workflow"), children: "Workflow" })
    ] }),
    /* @__PURE__ */ jsxs("div", { style: { flex: 1, overflowY: "auto" }, children: [
      activeTab === "status" && /* @__PURE__ */ jsxs("div", { style: { padding: 14, display: "flex", flexDirection: "column", gap: 16 }, children: [
        /* @__PURE__ */ jsx(StatusIndicator, { state: agentState }),
        /* @__PURE__ */ jsx(MetricsPanel, { state: agentState })
      ] }),
      activeTab === "events" && /* @__PURE__ */ jsx(EventTimeline, { events }),
      activeTab === "workflow" && /* @__PURE__ */ jsx(WorkflowContext, { context: workflowCtx })
    ] })
  ] });
}
function TabBtn({
  active,
  onClick,
  children
}) {
  return /* @__PURE__ */ jsx(
    "button",
    {
      onClick,
      style: {
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        padding: "8px 4px",
        border: "none",
        borderBottom: `2px solid ${active ? "#0078d4" : "transparent"}`,
        background: "transparent",
        color: active ? "#0078d4" : "#666",
        fontSize: 12,
        fontWeight: 500,
        cursor: "pointer",
        whiteSpace: "nowrap",
        fontFamily: "inherit"
      },
      children
    }
  );
}
function IndexPage() {
  const {
    state,
    events,
    workflow
  } = Route.useLoaderData();
  return /* @__PURE__ */ jsx(Dashboard, { initialState: state, initialEvents: events, initialWorkflow: workflow });
}

export { IndexPage as component };
//# sourceMappingURL=index-s1L02IHO.mjs.map
