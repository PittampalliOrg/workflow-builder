"use client";

import { Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { SpanDetailsPanel } from "@/components/observability/span-details-panel";
import { TraceStatusBadge } from "@/components/observability/trace-status-badge";
import { TraceTimeline } from "@/components/observability/trace-timeline";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useObservabilityTrace } from "@/hooks/use-observability-trace";
import { useObservabilityTraces } from "@/hooks/use-observability-traces";
import type {
	ObservabilityTraceDetails,
	ObservabilityTraceSummary,
} from "@/lib/types/observability";
import { getRelativeTime } from "@/lib/utils/time";
import { cn } from "@/lib/utils";
import { AgentProgressPanel } from "./agent-progress-panel";
import { RunDetailSheet } from "./run-detail-sheet";

type AgentRunInfo = {
	daprInstanceId: string;
	nodeId: string;
	status: string;
	mode?: string | null;
	totalTurns?: number | null;
	currentTurn?: number | null;
};

type RunTraceTabProps = {
	workflowId: string;
	executionId: string;
	daprInstanceId?: string | null;
	traceIds?: string[];
	agentRuns?: AgentRunInfo[];
	selectedTraceId: string | null;
	selectedSpanId: string | null;
	onSelectedTraceIdChange: (id: string | null) => void;
	onSelectedSpanIdChange: (id: string | null) => void;
};

function findSelectedSpan(
	trace: ObservabilityTraceDetails | null,
	spanId: string | null,
) {
	if (!trace || !spanId) {
		return null;
	}
	return trace.spans.find((span) => span.spanId === spanId) ?? null;
}

export function RunTraceTab({
	workflowId,
	executionId,
	daprInstanceId,
	traceIds = [],
	agentRuns = [],
	selectedTraceId,
	selectedSpanId,
	onSelectedTraceIdChange,
	onSelectedSpanIdChange,
}: RunTraceTabProps) {
	const {
		traces,
		hasNextPage,
		isLoading,
		isLoadingMore,
		isError,
		error,
		refresh,
		loadMore,
	} = useObservabilityTraces({
		filters: {
			entityType: "workflow",
			entityId: workflowId,
			search: executionId,
			limit: 25,
		},
	});

	const executionTraces = useMemo(() => {
		return traces
			.filter((trace) => {
				return (
					trace.executionId === executionId ||
					trace.parentExecutionId === executionId ||
					(daprInstanceId ? trace.daprInstanceId === daprInstanceId : false)
				);
			})
			.sort(
				(a, b) =>
					new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
			);
	}, [daprInstanceId, executionId, traces]);

	const traceIdHints = useMemo(() => {
		return Array.from(
			new Set(
				traceIds
					.map((value) => value.trim())
					.filter((value) => value.length > 0),
			),
		);
	}, [traceIds]);

	const fallbackTraceId = useMemo(() => {
		const knownTraceIds = new Set([
			...executionTraces.map((trace) => trace.traceId),
			...traceIdHints,
		]);
		if (selectedTraceId?.trim() && knownTraceIds.has(selectedTraceId)) {
			return selectedTraceId;
		}
		if (executionTraces.length > 0) {
			return executionTraces[0]?.traceId ?? null;
		}
		return traceIdHints[0] ?? null;
	}, [executionTraces, selectedTraceId, traceIdHints]);

	useEffect(() => {
		const knownTraceIds = new Set([
			...executionTraces.map((trace) => trace.traceId),
			...traceIdHints,
		]);
		const valid = selectedTraceId ? knownTraceIds.has(selectedTraceId) : false;
		if (!valid) {
			onSelectedTraceIdChange(fallbackTraceId);
		}
	}, [
		executionTraces,
		fallbackTraceId,
		onSelectedTraceIdChange,
		selectedTraceId,
		traceIdHints,
	]);

	const activeTraceId = fallbackTraceId;

	const {
		trace: activeTrace,
		isLoading: isLoadingTrace,
		isError: isTraceError,
		error: traceError,
		mutate: refreshTrace,
	} = useObservabilityTrace(activeTraceId, { executionId });

	useEffect(() => {
		if (!activeTrace || activeTrace.spans.length === 0) {
			if (selectedSpanId) {
				onSelectedSpanIdChange(null);
			}
			return;
		}
		if (!selectedSpanId) {
			return;
		}
		const valid = activeTrace.spans.some(
			(span) => span.spanId === selectedSpanId,
		);
		if (!valid) {
			onSelectedSpanIdChange(null);
		}
	}, [activeTrace, onSelectedSpanIdChange, selectedSpanId]);

	const selectedSpan = useMemo(
		() => findSelectedSpan(activeTrace, selectedSpanId),
		[activeTrace, selectedSpanId],
	);

	const activeSummary: ObservabilityTraceSummary | null = useMemo(() => {
		if (activeTrace) {
			return activeTrace.trace;
		}
		if (!activeTraceId) {
			return null;
		}
		return (
			executionTraces.find((trace) => trace.traceId === activeTraceId) ?? null
		);
	}, [activeTrace, activeTraceId, executionTraces]);

	const displayedTraces = useMemo(() => {
		if (executionTraces.length > 0) {
			return executionTraces;
		}
		if (activeTrace) {
			return [activeTrace.trace];
		}
		return [];
	}, [activeTrace, executionTraces]);

	const usingExplicitTraceReference =
		executionTraces.length === 0 &&
		Boolean(activeTraceId) &&
		traceIdHints.includes(activeTraceId ?? "");

	if (isError) {
		return (
			<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
				Failed to load traces:{" "}
				{error instanceof Error ? error.message : "Unknown error"}
			</div>
		);
	}

	if (isLoading && displayedTraces.length === 0 && !activeTraceId) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				Loading traces for this run...
			</div>
		);
	}

	if (displayedTraces.length === 0 && !activeTraceId && !isLoadingTrace) {
		return (
			<div className="rounded-lg border p-6 text-muted-foreground text-sm">
				No traces correlated to this run yet.
			</div>
		);
	}

	return (
		<>
			{agentRuns.length > 0 && (
				<AgentProgressPanel
					agentRuns={agentRuns}
					executionId={executionId}
				/>
			)}
			<div className="grid gap-3 xl:grid-cols-[280px_1fr]">
				<div className="overflow-hidden rounded-md border bg-background">
					<div className="flex items-center justify-between border-b px-3 py-2">
						<div>
							<div className="font-medium text-sm">Execution Traces</div>
							<div className="text-muted-foreground text-xs">
								{displayedTraces.length} trace(s)
							</div>
						</div>
						<Button onClick={() => refresh()} size="sm" variant="outline">
							<RefreshCw className="h-3.5 w-3.5" />
						</Button>
					</div>
					<div className="max-h-[320px] overflow-auto sm:max-h-[calc(100vh-17rem)]">
						{displayedTraces.map((trace) => {
							const selected = trace.traceId === activeTraceId;
							return (
								<button
									className={cn(
										"w-full border-b px-3 py-2 text-left hover:bg-muted/40",
										selected && "bg-primary/10",
									)}
									key={trace.traceId}
									onClick={() => {
										onSelectedTraceIdChange(trace.traceId);
										onSelectedSpanIdChange(null);
									}}
									type="button"
								>
									<div className="flex items-center justify-between gap-2">
										<p className="truncate font-mono text-xs">
											{trace.traceId.slice(0, 16)}...
										</p>
										<TraceStatusBadge status={trace.status} />
									</div>
									<p className="mt-1 truncate text-muted-foreground text-xs">
										{trace.name}
									</p>
									<p className="mt-1 text-muted-foreground text-xs">
										{getRelativeTime(trace.startedAt)} · {trace.durationMs} ms
									</p>
								</button>
							);
						})}
						{hasNextPage ? (
							<div className="p-3">
								<Button
									className="w-full"
									disabled={isLoadingMore}
									onClick={() => loadMore()}
									size="sm"
									variant="outline"
								>
									{isLoadingMore ? (
										<>
											<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
											Loading
										</>
									) : (
										"Load more"
									)}
								</Button>
							</div>
						) : null}
					</div>
				</div>

				<div className="space-y-3">
					<div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
						<div>
							<div className="font-medium text-sm">
								{activeSummary?.name ?? "Trace"}
							</div>
							<div className="font-mono text-muted-foreground text-xs">
								{activeSummary?.traceId ?? "-"}
							</div>
							{activeSummary ? (
								<div className="mt-2 flex flex-wrap gap-1">
									<Badge variant="outline">{activeSummary.runtime}</Badge>
									<Badge variant="secondary">
										{activeSummary.rootSpanCategory}
									</Badge>
									{activeSummary.serviceNames.map((serviceName) => (
										<Badge key={serviceName} variant="outline">
											{serviceName}
										</Badge>
									))}
								</div>
							) : null}
							{usingExplicitTraceReference ? (
								<p className="mt-2 text-muted-foreground text-xs">
									Using the trace ID recorded with this run because Tempo did
									not return a workflow-correlated search result yet.
								</p>
							) : null}
						</div>
						<div className="flex items-center gap-2">
							{activeSummary ? (
								<>
									<Button asChild size="sm" variant="outline">
										<Link
											href={`/observability/${activeSummary.traceId}?executionId=${encodeURIComponent(executionId)}`}
										>
											<ExternalLink className="mr-2 h-3.5 w-3.5" />
											Open Full Trace
										</Link>
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => {
											const url = `/api/observability/traces/${encodeURIComponent(activeSummary.traceId)}/raw?executionId=${encodeURIComponent(executionId)}`;
											window.open(url, "_blank");
										}}
									>
										<Download className="mr-2 h-3.5 w-3.5" />
										Raw JSON
									</Button>
								</>
							) : null}
							<Button
								disabled={!activeTraceId}
								onClick={() => refreshTrace()}
								size="sm"
								variant="outline"
							>
								<RefreshCw className="h-3.5 w-3.5" />
							</Button>
						</div>
					</div>

					{isTraceError ? (
						<div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
							Failed to load trace details:{" "}
							{traceError instanceof Error
								? traceError.message
								: "Unknown error"}
						</div>
					) : isLoadingTrace && !activeTrace ? (
						<div className="rounded-md border p-6 text-muted-foreground text-sm">
							Loading trace detail...
						</div>
					) : activeTrace ? (
						<div className="space-y-3">
							{activeSummary ? (
								<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
									<div className="rounded-md border bg-muted/20 px-3 py-2">
										<p className="text-muted-foreground text-xs">
											Workflow / child
										</p>
										<p className="text-sm">
											{activeSummary.breakdown.workflowSpans} /{" "}
											{activeSummary.breakdown.childWorkflowSpans}
										</p>
									</div>
									<div className="rounded-md border bg-muted/20 px-3 py-2">
										<p className="text-muted-foreground text-xs">Activities</p>
										<p className="text-sm">
											{activeSummary.breakdown.activitySpans}
										</p>
									</div>
									<div className="rounded-md border bg-muted/20 px-3 py-2">
										<p className="text-muted-foreground text-xs">
											Agent / tool
										</p>
										<p className="text-sm">
											{activeSummary.breakdown.agentSpans} /{" "}
											{activeSummary.breakdown.toolSpans}
										</p>
									</div>
									<div className="rounded-md border bg-muted/20 px-3 py-2">
										<p className="text-muted-foreground text-xs">LLM / HTTP</p>
										<p className="text-sm">
											{activeSummary.breakdown.llmSpans} /{" "}
											{activeSummary.breakdown.httpSpans}
										</p>
									</div>
								</div>
							) : null}
							<TraceTimeline
								onSelectSpan={onSelectedSpanIdChange}
								selectedSpanId={selectedSpanId ?? undefined}
								spans={activeTrace.spans}
							/>
						</div>
					) : (
						<div className="rounded-md border p-6 text-muted-foreground text-sm">
							Select a trace to inspect its span timeline.
						</div>
					)}
				</div>
			</div>

			<RunDetailSheet
				description={activeSummary?.traceId}
				onOpenChange={(open) => {
					if (!open) {
						onSelectedSpanIdChange(null);
					}
				}}
				open={Boolean(selectedSpan)}
				title={selectedSpan?.name ?? "Span details"}
			>
				<SpanDetailsPanel
					fallbackExecutionId={executionId}
					fallbackWorkflowId={workflowId}
					span={selectedSpan}
				/>
			</RunDetailSheet>
		</>
	);
}
