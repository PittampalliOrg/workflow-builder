import { useState, useEffect, useCallback } from "react";
import type { AgentState, AgentEvent, WorkflowContext as WfCtx } from "~/lib/types";
import { getAgentStatus } from "~/server-functions/get-agent-status";
import { getEventHistory } from "~/server-functions/get-event-history";
import { getWorkflowContext } from "~/server-functions/get-workflow-context";
import { StatusIndicator } from "./StatusIndicator";
import { MetricsPanel } from "./MetricsPanel";
import { EventTimeline } from "./EventTimeline";
import { WorkflowContext } from "./WorkflowContext";

type Tab = "status" | "events" | "workflow";

type DashboardProps = {
	initialState: AgentState | null;
	initialEvents: AgentEvent[] | null;
	initialWorkflow: WfCtx | null;
};

export function Dashboard({ initialState, initialEvents, initialWorkflow }: DashboardProps) {
	const [activeTab, setActiveTab] = useState<Tab>("status");
	const [agentState, setAgentState] = useState<AgentState | null>(initialState);
	const [events, setEvents] = useState<AgentEvent[] | null>(initialEvents);
	const [workflowCtx, setWorkflowCtx] = useState<WfCtx | null>(initialWorkflow);

	const poll = useCallback(async () => {
		try {
			const [status, evts, wfCtx] = await Promise.all([
				getAgentStatus(),
				getEventHistory(),
				getWorkflowContext(),
			]);
			setAgentState(status as AgentState);
			setEvents(evts as AgentEvent[]);
			setWorkflowCtx(wfCtx as WfCtx);
		} catch {
			// ignore poll errors
		}
	}, []);

	// Poll every 2 seconds for live updates
	useEffect(() => {
		const interval = setInterval(poll, 2000);
		return () => clearInterval(interval);
	}, [poll]);

	const eventCount = Array.isArray(events) ? events.length : 0;

	return (
		<div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif", fontSize: 13 }}>
			{/* Tab bar */}
			<div style={{ display: "flex", borderBottom: "1px solid #e5e5e5", background: "#f9f9f9", flexShrink: 0 }}>
				<TabBtn active={activeTab === "status"} onClick={() => setActiveTab("status")}>
					Status
				</TabBtn>
				<TabBtn active={activeTab === "events"} onClick={() => setActiveTab("events")}>
					Events
					{eventCount > 0 && (
						<span style={{ fontSize: 10, background: "#0078d4", color: "#fff", padding: "0 5px", borderRadius: 8, minWidth: 18, textAlign: "center", lineHeight: "16px", marginLeft: 4 }}>
							{eventCount}
						</span>
					)}
				</TabBtn>
				<TabBtn active={activeTab === "workflow"} onClick={() => setActiveTab("workflow")}>
					Workflow
				</TabBtn>
			</div>

			{/* Tab content */}
			<div style={{ flex: 1, overflowY: "auto" }}>
				{activeTab === "status" && (
					<div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 16 }}>
						<StatusIndicator state={agentState} />
						<MetricsPanel state={agentState} />
					</div>
				)}
				{activeTab === "events" && <EventTimeline events={events} />}
				{activeTab === "workflow" && <WorkflowContext context={workflowCtx} />}
			</div>
		</div>
	);
}

function TabBtn({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			onClick={onClick}
			style={{
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
				fontFamily: "inherit",
			}}
		>
			{children}
		</button>
	);
}
