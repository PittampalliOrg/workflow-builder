"use client";

import type { DurableTimelineEvent } from "@/lib/types/durable-timeline";
import { getRelativeTime } from "@/lib/utils/time";

type RunTimelineTabProps = {
	timeline: DurableTimelineEvent[];
	nodeIdFilter?: string | null;
};

export function RunTimelineTab({
	timeline,
	nodeIdFilter,
}: RunTimelineTabProps) {
	const filtered = nodeIdFilter
		? timeline.filter((event) => event.nodeId === nodeIdFilter)
		: timeline;

	if (timeline.length === 0) {
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
						{filtered.map((event) => (
							<tr className="border-b align-top" key={event.id}>
								<td className="px-3 py-2">
									<span title={new Date(event.ts).toLocaleString()}>
										{getRelativeTime(event.ts)}
									</span>
								</td>
								<td className="px-3 py-2">
									<div className="font-medium">{event.kind}</div>
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
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
