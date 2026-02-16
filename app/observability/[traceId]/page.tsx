"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { TraceSpansTable } from "@/components/observability/trace-spans-table";
import { TraceStatusBadge } from "@/components/observability/trace-status-badge";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { useObservabilityTrace } from "@/hooks/use-observability-trace";

export default function TraceDetailPage() {
	const params = useParams<{ traceId: string }>();
	const traceId = params.traceId;

	const { trace, isLoading, isError, error, mutate } = useObservabilityTrace(
		traceId ?? null,
	);

	if (isLoading && !trace) {
		return (
			<div className="container mx-auto py-6">
				<div className="rounded-lg border p-6 text-muted-foreground text-sm">
					Loading trace details...
				</div>
			</div>
		);
	}

	if (isError || !trace) {
		return (
			<div className="container mx-auto space-y-4 py-6">
				<div className="flex items-center gap-3">
					<SidebarToggle />
					<Button asChild size="sm" variant="outline">
						<Link href="/observability">
							<ArrowLeft className="mr-2 h-4 w-4" />
							Back to observability
						</Link>
					</Button>
				</div>
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
					Failed to load trace:{" "}
					{error instanceof Error ? error.message : "Unknown error"}
				</div>
			</div>
		);
	}

	return (
		<div className="container mx-auto space-y-6 py-6">
			<div className="flex items-center justify-between">
				<div className="space-y-2">
					<div className="flex items-center gap-3">
						<SidebarToggle />
						<Button asChild size="sm" variant="outline">
							<Link href="/observability">
								<ArrowLeft className="mr-2 h-4 w-4" />
								Back
							</Link>
						</Button>
					</div>
					<h1 className="font-bold text-2xl">{trace.trace.name}</h1>
					<p className="font-mono text-muted-foreground text-xs">
						Trace ID: {trace.trace.traceId}
					</p>
				</div>
				<Button onClick={() => mutate()} size="sm" variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					Refresh
				</Button>
			</div>

			<div className="grid gap-4 rounded-lg border bg-background p-4 md:grid-cols-2 xl:grid-cols-4">
				<div>
					<p className="text-muted-foreground text-xs">Status</p>
					<div className="mt-1">
						<TraceStatusBadge status={trace.trace.status} />
					</div>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Started</p>
					<p className="mt-1 text-sm">
						{new Date(trace.trace.startedAt).toLocaleString()}
					</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Duration</p>
					<p className="mt-1 text-sm">{trace.trace.durationMs} ms</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Spans</p>
					<p className="mt-1 text-sm">{trace.trace.spanCount}</p>
				</div>
			</div>

			<div className="grid gap-4 rounded-lg border bg-background p-4 md:grid-cols-2">
				<div>
					<p className="text-muted-foreground text-xs">Workflow</p>
					<p className="mt-1 text-sm">
						{trace.trace.workflowName ?? trace.trace.workflowId ?? "-"}
					</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Execution</p>
					<p className="mt-1 font-mono text-sm">
						{trace.trace.executionId ?? trace.trace.daprInstanceId ?? "-"}
					</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Service</p>
					<p className="mt-1 text-sm">{trace.trace.serviceName ?? "-"}</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Phase</p>
					<p className="mt-1 text-sm">{trace.trace.phase ?? "-"}</p>
				</div>
			</div>

			<div className="flex flex-wrap gap-2">
				{trace.trace.executionId && (
					<Button asChild size="sm" variant="outline">
						<Link href={`/monitor/${trace.trace.executionId}`}>
							Open monitor view
						</Link>
					</Button>
				)}
				{trace.trace.workflowId && trace.trace.executionId && (
					<Button asChild size="sm" variant="outline">
						<Link
							href={`/workflows/${trace.trace.workflowId}/runs/${trace.trace.executionId}`}
						>
							Open workflow run
						</Link>
					</Button>
				)}
			</div>

			<div className="space-y-3">
				<h2 className="font-semibold text-lg">Spans</h2>
				<TraceSpansTable spans={trace.spans} />
			</div>
		</div>
	);
}
