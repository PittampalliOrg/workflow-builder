"use client";

import { useState } from "react";
import type { DurableTimelineEvent } from "@/lib/types/durable-timeline";
import type { AgentStreamEvent } from "@/lib/types/agent-stream-events";
import { getRelativeTime } from "@/lib/utils/time";
import { cn } from "@/lib/utils";

type RunTimelineTabProps = {
	timeline: DurableTimelineEvent[];
	nodeIdFilter?: string | null;
	/** Real-time agent stream events (merged into timeline) */
	agentStreamEvents?: AgentStreamEvent[];
};

/** Convert agent stream events to timeline-compatible rows */
function agentStreamToTimelineRows(
	events: AgentStreamEvent[],
): DurableTimelineEvent[] {
	return events
		.filter(
			(e) =>
				e.type === "tool_call_start" ||
				e.type === "tool_start" ||
				e.type === "tool_call_end" ||
				e.type === "tool_complete" ||
				e.type === "tool_call_error" ||
				e.type === "tool_error" ||
				e.type === "llm_start" ||
				e.type === "model_start" ||
				e.type === "llm_complete" ||
				e.type === "model_complete" ||
				e.type === "run_started" ||
				e.type === "run_complete" ||
				e.type === "run_error",
		)
		.map((e) => {
			const kind = mapStreamTypeToKind(e.type);
			return {
				id: e.id || `stream-${e.ts}-${e.type}`,
				ts: e.ts,
				kind,
				source: "agent_run" as const,
				status: e.status ?? null,
				nodeId: null,
				nodeName: null,
				activityName: e.toolName ?? null,
				label: buildStreamLabel(e),
				durationMs: e.durationMs ?? null,
			};
		});
}

function mapStreamTypeToKind(type: string): DurableTimelineEvent["kind"] {
	switch (type) {
		case "tool_call_start":
		case "tool_start":
			return "agent_tool_start";
		case "tool_call_end":
		case "tool_complete":
			return "agent_tool_complete";
		case "tool_call_error":
		case "tool_error":
			return "agent_tool_error";
		case "llm_start":
		case "model_start":
			return "agent_llm_start";
		case "llm_complete":
		case "model_complete":
			return "agent_llm_complete";
		default:
			return "node_started";
	}
}

function buildStreamLabel(e: AgentStreamEvent): string {
	switch (e.type) {
		case "tool_call_start":
		case "tool_start":
			return `Running ${e.toolName || "tool"}`;
		case "tool_call_end":
		case "tool_complete":
			return `Completed ${e.toolName || "tool"}${e.durationMs ? ` (${e.durationMs}ms)` : ""}`;
		case "tool_call_error":
		case "tool_error":
			return `Failed ${e.toolName || "tool"}: ${e.error || "error"}`;
		case "llm_start":
		case "model_start":
			return "LLM generation started";
		case "llm_complete":
		case "model_complete":
			return "LLM generation completed";
		case "run_started":
			return `Agent run started (${e.phase || ""})`;
		case "run_complete":
			return "Agent run completed";
		case "run_error":
			return `Agent run failed: ${e.error || ""}`;
		default:
			return e.type;
	}
}

function isAgentToolKind(kind: string): boolean {
	return (
		kind === "agent_tool_start" ||
		kind === "agent_tool_complete" ||
		kind === "agent_tool_error"
	);
}

export function RunTimelineTab({
	timeline,
	nodeIdFilter,
	agentStreamEvents,
}: RunTimelineTabProps) {
	const [expandedRow, setExpandedRow] = useState<string | null>(null);

	// Merge real-time agent events into timeline
	const streamRows = agentStreamEvents
		? agentStreamToTimelineRows(agentStreamEvents)
		: [];
	const allEvents = [...timeline, ...streamRows].sort(
		(a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime(),
	);

	const filtered = nodeIdFilter
		? allEvents.filter((event) => event.nodeId === nodeIdFilter)
		: allEvents;

	if (allEvents.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No timeline events were captured for this run.
			</div>
		);
	}

	if (filtered.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No timeline events found for node <code>{nodeIdFilter}</code>.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-md border bg-background">
			<div className="max-h-[340px] overflow-auto sm:max-h-[calc(100vh-17rem)]">
				<table className="w-full text-sm">
					<thead className="sticky top-0 z-10 bg-background">
						<tr className="border-b text-left">
							<th className="px-3 py-2 font-medium">Time</th>
							<th className="px-3 py-2 font-medium">Event</th>
							<th className="px-3 py-2 font-medium">Node</th>
							<th className="px-3 py-2 font-medium">Activity</th>
							<th className="px-3 py-2 font-medium">Status</th>
							<th className="px-3 py-2 font-medium">Source</th>
						</tr>
					</thead>
					<tbody>
						{filtered.map((event) => {
							const isToolEvent = isAgentToolKind(event.kind);
							const isRunning =
								event.kind === "agent_tool_start" &&
								!filtered.some(
									(e) =>
										(e.kind === "agent_tool_complete" ||
											e.kind === "agent_tool_error") &&
										e.activityName === event.activityName &&
										new Date(e.ts).getTime() > new Date(event.ts).getTime(),
								);

							return (
								<tr
									className={cn(
										"border-b align-top",
										isToolEvent && "cursor-pointer hover:bg-muted/50",
										isRunning && "bg-blue-50/50 dark:bg-blue-950/20",
									)}
									key={event.id}
									onClick={() =>
										isToolEvent
											? setExpandedRow(
													expandedRow === event.id ? null : event.id,
												)
											: undefined
									}
								>
									<td className="px-3 py-2">
										<span title={new Date(event.ts).toLocaleString()}>
											{getRelativeTime(event.ts)}
										</span>
									</td>
									<td className="px-3 py-2">
										<div className="flex items-center gap-1.5">
											{isRunning && (
												<span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
											)}
											<span className="font-medium">{event.kind}</span>
										</div>
										<div className="text-muted-foreground text-xs">
											{event.label}
										</div>
									</td>
									<td className="px-3 py-2 font-mono text-xs">
										{event.nodeName ?? event.nodeId ?? "-"}
									</td>
									<td className="max-w-[240px] truncate px-3 py-2">
										{event.activityName ?? "-"}
									</td>
									<td className="px-3 py-2">{event.status ?? "-"}</td>
									<td className="px-3 py-2 text-xs">{event.source}</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
