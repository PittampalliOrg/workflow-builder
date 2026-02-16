"use client";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { ObservabilitySpan } from "@/lib/types/observability";

type TraceSpansTableProps = {
	spans: ObservabilitySpan[];
};

export function TraceSpansTable({ spans }: TraceSpansTableProps) {
	if (spans.length === 0) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No spans found for this trace.
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-lg border bg-background">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Span</TableHead>
						<TableHead>Name</TableHead>
						<TableHead>Service</TableHead>
						<TableHead>Start</TableHead>
						<TableHead>Duration</TableHead>
						<TableHead>Status</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{spans.map((span) => (
						<TableRow key={span.spanId}>
							<TableCell className="font-mono text-xs">
								{span.spanId.slice(0, 12)}...
							</TableCell>
							<TableCell className="max-w-[340px] truncate">
								{span.name}
							</TableCell>
							<TableCell>{span.serviceName ?? "-"}</TableCell>
							<TableCell>{new Date(span.startedAt).toLocaleString()}</TableCell>
							<TableCell>{span.durationMs} ms</TableCell>
							<TableCell>{span.statusCode ?? "-"}</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
