"use client";

import type { DurableAgentRunSummary } from "@/lib/types/durable-timeline";
import { getRelativeTime } from "@/lib/utils/time";

function extractChildRunSummary(run: DurableAgentRunSummary): string {
	if (!run.result || typeof run.result !== "object") {
		return "-";
	}
	const record = run.result as Record<string, unknown>;
	const progress =
		record.agentProgress && typeof record.agentProgress === "object"
			? (record.agentProgress as Record<string, unknown>)
			: null;
	const text = typeof record.text === "string" ? record.text : null;
	const summary =
		progress && typeof progress.summary === "string" ? progress.summary : text;
	return summary ? summary.slice(0, 120) : "-";
}

function extractTraceId(run: DurableAgentRunSummary): string | null {
	if (!run.result || typeof run.result !== "object") {
		return null;
	}
	const record = run.result as Record<string, unknown>;
	if (typeof record.traceId === "string") {
		return record.traceId;
	}
	const progress =
		record.agentProgress && typeof record.agentProgress === "object"
			? (record.agentProgress as Record<string, unknown>)
			: null;
	return typeof progress?.traceId === "string" ? progress.traceId : null;
}

type RunChildRunsTabProps = {
	agentRuns: DurableAgentRunSummary[];
};

export function RunChildRunsTab({ agentRuns }: RunChildRunsTabProps) {
	if (agentRuns.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No agent child runs were recorded for this execution.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-md border bg-background">
			<div className="max-h-[340px] overflow-auto sm:max-h-[calc(100vh-17rem)]">
				<table className="w-full text-sm">
					<thead className="sticky top-0 z-10 bg-background">
						<tr className="border-b text-left">
							<th className="px-3 py-2 font-medium">Run ID</th>
							<th className="px-3 py-2 font-medium">Mode</th>
							<th className="px-3 py-2 font-medium">Node</th>
							<th className="px-3 py-2 font-medium">Status</th>
							<th className="px-3 py-2 font-medium">Started</th>
							<th className="px-3 py-2 font-medium">Completed</th>
							<th className="px-3 py-2 font-medium">Agent Instance</th>
							<th className="px-3 py-2 font-medium">Trace</th>
							<th className="px-3 py-2 font-medium">Summary</th>
						</tr>
					</thead>
					<tbody>
						{agentRuns.map((run) => (
							<tr className="border-b align-top" key={run.id}>
								<td className="px-3 py-2 font-mono text-xs">
									{run.id.slice(0, 12)}...
								</td>
								<td className="px-3 py-2">{run.mode}</td>
								<td className="px-3 py-2 font-mono text-xs">{run.nodeId}</td>
								<td className="px-3 py-2">{run.status}</td>
								<td className="px-3 py-2">
									<span title={new Date(run.createdAt).toLocaleString()}>
										{getRelativeTime(run.createdAt)}
									</span>
								</td>
								<td className="px-3 py-2">
									{run.completedAt ? (
										<span title={new Date(run.completedAt).toLocaleString()}>
											{getRelativeTime(run.completedAt)}
										</span>
									) : (
										"-"
									)}
								</td>
								<td className="px-3 py-2 font-mono text-xs">
									{run.daprInstanceId.slice(0, 14)}...
								</td>
								<td className="px-3 py-2 font-mono text-xs">
									{extractTraceId(run)?.slice(0, 14) ?? "-"}
								</td>
								<td className="max-w-xs px-3 py-2 text-xs">
									{extractChildRunSummary(run)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
