import { useState } from "react";

type AgentEvent = {
  id: string;
  type: string;
  timestamp: string;
  runId: string | null;
  callId?: string;
  data: Record<string, unknown>;
};

const TYPE_COLORS: Record<string, string> = {
  agent_started: "#8b5cf6",
  agent_completed: "#8b5cf6",
  tool_call: "#10b981",
  tool_result: "#10b981",
  llm_start: "#3b82f6",
  llm_end: "#3b82f6",
  dapr_event: "#6b7280",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function EventItem({ event }: { event: AgentEvent }) {
  const [expanded, setExpanded] = useState(false);
  const color = TYPE_COLORS[event.type] ?? "#6b7280";

  return (
    <div className="event-item" onClick={() => setExpanded(!expanded)}>
      <div className="event-row">
        <span className="event-time">{formatTime(event.timestamp)}</span>
        <span className="event-badge" style={{ background: color }}>
          {event.type.replace(/_/g, " ")}
        </span>
        {event.callId && (
          <span className="event-callid" title="Call ID">
            {event.callId}
          </span>
        )}
        <span className="event-expand">{expanded ? "\u25BC" : "\u25B6"}</span>
      </div>
      {expanded && (
        <pre className="event-data">
          {JSON.stringify(event.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function EventTimeline({ events }: { events: AgentEvent[] | null }) {
  if (!events || events.length === 0) {
    return (
      <div className="empty-state">
        <span>No events yet</span>
        <span className="empty-hint">
          Run the agent to see events appear here
        </span>
      </div>
    );
  }

  return (
    <div className="event-timeline">
      {events.map((event) => (
        <EventItem key={event.id} event={event} />
      ))}
    </div>
  );
}
