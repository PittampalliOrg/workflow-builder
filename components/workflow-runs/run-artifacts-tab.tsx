"use client";

import type {
	DurableExternalEventSummary,
	DurablePlanArtifactSummary,
} from "@/lib/types/durable-timeline";
import { getRelativeTime } from "@/lib/utils/time";

type RunArtifactsTabProps = {
	planArtifacts: DurablePlanArtifactSummary[];
	externalEvents: DurableExternalEventSummary[];
};

export function RunArtifactsTab({
	planArtifacts,
	externalEvents,
}: RunArtifactsTabProps) {
	if (planArtifacts.length === 0 && externalEvents.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No durable artifacts or external events were recorded for this run.
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="rounded-md border bg-background">
				<div className="border-b px-3 py-2 font-medium text-sm">
					Plan Artifacts ({planArtifacts.length})
				</div>
				{planArtifacts.length === 0 ? (
					<div className="p-3 text-muted-foreground text-sm">
						No plan artifacts.
					</div>
				) : (
					<div className="max-h-[220px] overflow-auto">
						<table className="w-full text-sm">
							<thead className="sticky top-0 z-10 bg-background">
								<tr className="border-b text-left">
									<th className="px-3 py-2 font-medium">ID</th>
									<th className="px-3 py-2 font-medium">Node</th>
									<th className="px-3 py-2 font-medium">Status</th>
									<th className="px-3 py-2 font-medium">Goal</th>
									<th className="px-3 py-2 font-medium">Created</th>
								</tr>
							</thead>
							<tbody>
								{planArtifacts.map((artifact) => (
									<tr className="border-b align-top" key={artifact.id}>
										<td className="px-3 py-2 font-mono text-xs">
											{artifact.id.slice(0, 12)}...
										</td>
										<td className="px-3 py-2 font-mono text-xs">
											{artifact.nodeId}
										</td>
										<td className="px-3 py-2">{artifact.status}</td>
										<td className="max-w-[380px] truncate px-3 py-2">
											{artifact.goal}
										</td>
										<td className="px-3 py-2">
											<span
												title={new Date(artifact.createdAt).toLocaleString()}
											>
												{getRelativeTime(artifact.createdAt)}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>

			<div className="rounded-md border bg-background">
				<div className="border-b px-3 py-2 font-medium text-sm">
					External Events ({externalEvents.length})
				</div>
				{externalEvents.length === 0 ? (
					<div className="p-3 text-muted-foreground text-sm">
						No external events.
					</div>
				) : (
					<div className="max-h-[220px] overflow-auto">
						<table className="w-full text-sm">
							<thead className="sticky top-0 z-10 bg-background">
								<tr className="border-b text-left">
									<th className="px-3 py-2 font-medium">Event</th>
									<th className="px-3 py-2 font-medium">Type</th>
									<th className="px-3 py-2 font-medium">Node</th>
									<th className="px-3 py-2 font-medium">Approved</th>
									<th className="px-3 py-2 font-medium">Created</th>
								</tr>
							</thead>
							<tbody>
								{externalEvents.map((event) => (
									<tr className="border-b align-top" key={event.id}>
										<td className="max-w-[340px] truncate px-3 py-2">
											{event.eventName}
										</td>
										<td className="px-3 py-2">{event.eventType}</td>
										<td className="px-3 py-2 font-mono text-xs">
											{event.nodeId}
										</td>
										<td className="px-3 py-2">
											{event.approved === null ? "-" : String(event.approved)}
										</td>
										<td className="px-3 py-2">
											<span title={new Date(event.createdAt).toLocaleString()}>
												{getRelativeTime(event.createdAt)}
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>
		</div>
	);
}
