"use client";

import { ArrowLeft, ExternalLink, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { SpanDetailsPanel } from "@/components/observability/span-details-panel";
import { TraceStatusBadge } from "@/components/observability/trace-status-badge";
import { TraceTimeline } from "@/components/observability/trace-timeline";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useObservabilityTrace } from "@/hooks/use-observability-trace";

export default function TraceDetailPage() {
	const params = useParams<{ traceId: string }>();
	const searchParams = useSearchParams();
	const traceId = params.traceId;
	const executionId = searchParams.get("executionId");

	const { trace, isLoading, isError, error, mutate } = useObservabilityTrace(
		traceId ?? null,
		{ executionId },
	);
	const [selectedSpanId, setSelectedSpanId] = useState<string | undefined>();

	const selectedSpan = useMemo(() => {
		if (!trace || !selectedSpanId) {
			return null;
		}
		return trace.spans.find((span) => span.spanId === selectedSpanId) ?? null;
	}, [selectedSpanId, trace]);

	useEffect(() => {
		if (!trace || trace.spans.length === 0) {
			setSelectedSpanId(undefined);
			return;
		}

		if (
			selectedSpanId &&
			trace.spans.some((s) => s.spanId === selectedSpanId)
		) {
			return;
		}

		const firstSpan =
			[...trace.spans].sort(
				(a, b) =>
					new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
			)[0]?.spanId ?? trace.spans[0]?.spanId;
		setSelectedSpanId(firstSpan);
	}, [selectedSpanId, trace]);

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

	const effectiveExecutionId =
		trace.trace.executionId ??
		trace.trace.parentExecutionId ??
		trace.trace.daprInstanceId ??
		null;

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
				<div className="flex items-center gap-2">
					<Button onClick={() => mutate()} size="sm" variant="outline">
						<RefreshCw className="mr-2 h-4 w-4" />
						Refresh
					</Button>
					{process.env.NEXT_PUBLIC_PHOENIX_URL ? (
						<Button asChild size="sm" variant="outline">
							<a
								href={`${process.env.NEXT_PUBLIC_PHOENIX_URL}/projects/default/traces/${traceId}`}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLink className="mr-2 h-4 w-4" />
								View in Phoenix
							</a>
						</Button>
					) : null}
				</div>
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
				<div>
					<p className="text-muted-foreground text-xs">Runtime</p>
					<div className="mt-1 flex flex-wrap gap-1">
						<Badge variant="outline">{trace.trace.runtime}</Badge>
						<Badge variant="secondary">{trace.trace.rootSpanCategory}</Badge>
					</div>
				</div>
			</div>

			<div className="grid gap-4 rounded-lg border bg-background p-4 md:grid-cols-2 xl:grid-cols-3">
				<div>
					<p className="text-muted-foreground text-xs">Workflow</p>
					<p className="mt-1 text-sm">
						{trace.trace.workflowName ?? trace.trace.workflowId ?? "-"}
					</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Execution</p>
					<p className="mt-1 font-mono text-sm">
						{effectiveExecutionId ?? "-"}
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
				<div>
					<p className="text-muted-foreground text-xs">Node</p>
					<p className="mt-1 text-sm">
						{trace.trace.nodeName ?? trace.trace.nodeId ?? "-"}
					</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Activity</p>
					<p className="mt-1 text-sm">{trace.trace.activityName ?? "-"}</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Correlation</p>
					<p className="mt-1 text-sm">
						{trace.trace.correlationConfidence ?? "-"}
					</p>
				</div>
				<div className="xl:col-span-2">
					<p className="text-muted-foreground text-xs">Services</p>
					<div className="mt-1 flex flex-wrap gap-1">
						{trace.trace.serviceNames.length > 0 ? (
							trace.trace.serviceNames.map((serviceName) => (
								<Badge key={serviceName} variant="outline">
									{serviceName}
								</Badge>
							))
						) : (
							<p className="text-sm">-</p>
						)}
					</div>
				</div>
				<div className="xl:col-span-3">
					<p className="text-muted-foreground text-xs">
						Dapr workflow and agent breakdown
					</p>
					<div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
						<div className="rounded-md border bg-muted/20 p-3">
							<p className="text-muted-foreground text-xs">Workflow / child</p>
							<p className="mt-1 text-sm">
								{trace.trace.breakdown.workflowSpans} /{" "}
								{trace.trace.breakdown.childWorkflowSpans}
							</p>
						</div>
						<div className="rounded-md border bg-muted/20 p-3">
							<p className="text-muted-foreground text-xs">Activities</p>
							<p className="mt-1 text-sm">
								{trace.trace.breakdown.activitySpans}
							</p>
						</div>
						<div className="rounded-md border bg-muted/20 p-3">
							<p className="text-muted-foreground text-xs">Agent / tool</p>
							<p className="mt-1 text-sm">
								{trace.trace.breakdown.agentSpans} /{" "}
								{trace.trace.breakdown.toolSpans}
							</p>
						</div>
						<div className="rounded-md border bg-muted/20 p-3">
							<p className="text-muted-foreground text-xs">LLM / HTTP</p>
							<p className="mt-1 text-sm">
								{trace.trace.breakdown.llmSpans} /{" "}
								{trace.trace.breakdown.httpSpans}
							</p>
						</div>
					</div>
				</div>
			</div>

			<div className="flex flex-wrap gap-2">
				{effectiveExecutionId && (
					<Button asChild size="sm" variant="outline">
						<Link href={`/monitor/${effectiveExecutionId}`}>
							Open monitor view
						</Link>
					</Button>
				)}
				{trace.trace.workflowId && effectiveExecutionId && (
					<Button asChild size="sm" variant="outline">
						<Link
							href={`/workflows/${trace.trace.workflowId}/runs/${effectiveExecutionId}?tab=trace`}
						>
							Open workflow run
						</Link>
					</Button>
				)}
			</div>

			<div className="space-y-3">
				<div className="flex items-center justify-between gap-3">
					<h2 className="font-semibold text-lg">Trace timeline</h2>
					<p className="text-muted-foreground text-xs">
						Select a span to inspect details and attributes
					</p>
				</div>
				<div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
					<TraceTimeline
						onSelectSpan={setSelectedSpanId}
						selectedSpanId={selectedSpanId}
						spans={trace.spans}
					/>
					<SpanDetailsPanel
						fallbackExecutionId={effectiveExecutionId}
						fallbackWorkflowId={trace.trace.workflowId}
						span={selectedSpan}
					/>
				</div>
			</div>
		</div>
	);
}
