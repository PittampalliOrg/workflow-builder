import { useState } from "react";
import type { AgentEvent } from "~/lib/types";

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
		<div
			onClick={() => setExpanded(!expanded)}
			style={{
				padding: "8px 14px",
				borderBottom: "1px solid #e5e5e5",
				cursor: "pointer",
			}}
		>
			<div style={{ display: "flex", alignItems: "center", gap: 6 }}>
				<span style={{ fontSize: 10, fontFamily: "monospace", color: "#999", flexShrink: 0 }}>
					{formatTime(event.timestamp)}
				</span>
				<span
					style={{
						fontSize: 9,
						fontWeight: 600,
						color: "#fff",
						padding: "1px 6px",
						borderRadius: 3,
						textTransform: "uppercase",
						letterSpacing: 0.3,
						whiteSpace: "nowrap",
						background: color,
					}}
				>
					{event.type.replace(/_/g, " ")}
				</span>
				{event.callId && (
					<span style={{ fontSize: 9, fontFamily: "monospace", color: "#999", background: "#eee", padding: "1px 4px", borderRadius: 3 }}>
						{event.callId}
					</span>
				)}
				<span style={{ marginLeft: "auto", fontSize: 9, color: "#999" }}>
					{expanded ? "\u25BC" : "\u25B6"}
				</span>
			</div>
			{expanded && (
				<pre
					style={{
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
						overflowY: "auto",
					}}
				>
					{JSON.stringify(event.data, null, 2)}
				</pre>
			)}
		</div>
	);
}

export function EventTimeline({ events }: { events: AgentEvent[] | null }) {
	if (!events || events.length === 0) {
		return (
			<div style={{ padding: "32px 16px", color: "#999", textAlign: "center", fontSize: 13 }}>
				<div>No events yet</div>
				<div style={{ fontSize: 11, marginTop: 4 }}>
					Run the agent to see events appear here
				</div>
			</div>
		);
	}

	return (
		<div>
			{events.map((event) => (
				<EventItem key={event.id} event={event} />
			))}
		</div>
	);
}
