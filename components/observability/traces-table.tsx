"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { ObservabilityTraceSummary } from "@/lib/types/observability";
import { getRelativeTime } from "@/lib/utils/time";
import { TraceStatusBadge } from "./trace-status-badge";

type TracesTableProps = {
	traces: ObservabilityTraceSummary[];
	isLoading?: boolean;
};

export function TracesTable({ traces, isLoading }: TracesTableProps) {
	if (isLoading && traces.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				Loading traces...
			</div>
		);
	}

	if (traces.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No traces found for the selected filters.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-lg border bg-background">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Trace</TableHead>
						<TableHead>Name</TableHead>
						<TableHead>Workflow</TableHead>
						<TableHead>Execution</TableHead>
						<TableHead>Started</TableHead>
						<TableHead>Duration</TableHead>
						<TableHead>Spans</TableHead>
						<TableHead>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{traces.map((trace) => (
						<TableRow className="hover:bg-muted/40" key={trace.traceId}>
							<TableCell className="font-mono text-xs">
								<Link
									className="inline-flex items-center gap-1 text-primary hover:underline"
									href={`/observability/${trace.traceId}`}
								>
									{trace.traceId.slice(0, 12)}...
									<ExternalLink className="h-3.5 w-3.5" />
								</Link>
							</TableCell>
							<TableCell className="max-w-[280px] truncate">
								{trace.name}
							</TableCell>
							<TableCell className="max-w-[220px] truncate">
								{trace.workflowName ?? trace.workflowId ?? "-"}
							</TableCell>
							<TableCell className="font-mono text-xs">
								{trace.executionId
									? `${trace.executionId.slice(0, 12)}...`
									: "-"}
							</TableCell>
							<TableCell>
								<span title={new Date(trace.startedAt).toLocaleString()}>
									{getRelativeTime(trace.startedAt)}
								</span>
							</TableCell>
							<TableCell>{trace.durationMs} ms</TableCell>
							<TableCell>{trace.spanCount}</TableCell>
							<TableCell>
								<TraceStatusBadge status={trace.status} />
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
