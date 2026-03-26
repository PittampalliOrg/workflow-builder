"use client";

import { ArrowLeft, Pause, Play, RefreshCw, Square } from "lucide-react";
import Link from "next/link";
import {
	useParams,
	usePathname,
	useRouter,
	useSearchParams,
} from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AgentLlmStream } from "@/components/workflow-runs/agent-llm-stream";
import { ExecutionChangesPanel } from "@/components/workflow-runs/execution-changes-panel";
import { RunArtifactsTab } from "@/components/workflow-runs/run-artifacts-tab";
import { RunChildRunsTab } from "@/components/workflow-runs/run-child-runs-tab";
import { RunLogsTab } from "@/components/workflow-runs/run-logs-tab";
import { RunOverviewTab } from "@/components/workflow-runs/run-overview-tab";
import { RunTimelineTab } from "@/components/workflow-runs/run-timeline-tab";
import { RunTraceTab } from "@/components/workflow-runs/run-trace-tab";
import { RunSandboxTab } from "@/components/workflow-runs/run-sandbox-tab";
import { SandboxOutput } from "@/components/workflow-runs/sandbox-output";
import { ExecutionStatusBadge } from "@/components/workflow-runs/execution-status-badge";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAgentStream } from "@/hooks/use-agent-stream";
import { useMonitorExecution } from "@/hooks/use-monitor-execution";
import { api } from "@/lib/api-client";
import {
	extractExecutionTraceIds,
	parseDaprAgentOutput,
	parseExecutionFileChangeData,
} from "@/lib/transforms/workflow-ui";

type ExecutionLogsResponse = Awaited<
	ReturnType<typeof api.workflow.getExecutionLogs>
>;
type ExecutionStatusResponse = Awaited<
	ReturnType<typeof api.workflow.getExecutionStatus>
>;

type WorkspaceTab =
	| "overview"
	| "timeline"
	| "activities"
	| "child-runs"
	| "artifacts"
	| "changes"
	| "trace"
	| "sandbox";

const VALID_TABS: WorkspaceTab[] = [
	"overview",
	"timeline",
	"activities",
	"child-runs",
	"artifacts",
	"changes",
	"trace",
	"sandbox",
];

function readTraceIdFromUnknown(value: unknown): string | null {
	if (!value || typeof value !== "object") {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.traceId === "string" && record.traceId.trim()) {
		return record.traceId;
	}
	const agentProgress =
		record.agentProgress && typeof record.agentProgress === "object"
			? (record.agentProgress as Record<string, unknown>)
			: null;
	if (
		agentProgress &&
		typeof agentProgress.traceId === "string" &&
		agentProgress.traceId.trim()
	) {
		return agentProgress.traceId;
	}
	return null;
}

function normalizeTab(value: string | null): WorkspaceTab {
	if (!value) {
		return "overview";
	}
	if (value === "logs") {
		return "activities";
	}
	return VALID_TABS.includes(value as WorkspaceTab)
		? (value as WorkspaceTab)
		: "overview";
}

export default function WorkflowRunDetailPage() {
	const params = useParams<{ workflowId: string; executionId: string }>();
	const searchParams = useSearchParams();
	const pathname = usePathname();
	const router = useRouter();

	const workflowId = params.workflowId;
	const executionId = params.executionId;

	const [workflowName, setWorkflowName] = useState<string>("");
	const [details, setDetails] = useState<ExecutionLogsResponse | null>(null);
	const [runtimeStatus, setRuntimeStatus] =
		useState<ExecutionStatusResponse | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<string | null>(null);
	const [browserArtifactCount, setBrowserArtifactCount] = useState(0);

	const { execution: monitorExecution } = useMonitorExecution(
		executionId ?? null,
	);

	const load = useCallback(async () => {
		if (!workflowId || !executionId) {
			return;
		}

		try {
			setIsLoading(true);
			setError(null);

			const [workflow, executionLogs, status] = await Promise.all([
				api.workflow.getById(workflowId),
				api.workflow.getExecutionLogs(executionId),
				api.workflow.getExecutionStatus(executionId),
			]);

			setWorkflowName(workflow?.name ?? executionLogs.execution.workflow.name);
			setDetails(executionLogs);
			setRuntimeStatus(status);
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: "Failed to load workflow run detail",
			);
		} finally {
			setIsLoading(false);
		}
	}, [executionId, workflowId]);

	useEffect(() => {
		load();
	}, [load]);

	const effectiveStatus = useMemo(() => {
		return runtimeStatus?.status ?? details?.execution.status ?? "unknown";
	}, [details?.execution.status, runtimeStatus?.status]);
	const canonicalExecutionId = details?.execution.id ?? executionId;

	const isRunActive = ["running", "pending"].includes(
		effectiveStatus.toLowerCase(),
	);
	const normalizedStatus = effectiveStatus.toUpperCase();
	const canPause =
		normalizedStatus === "RUNNING" || normalizedStatus === "PENDING";
	const canResume = normalizedStatus === "SUSPENDED";
	const canTerminate =
		normalizedStatus === "RUNNING" ||
		normalizedStatus === "PENDING" ||
		normalizedStatus === "SUSPENDED";

	const runAction = useCallback(
		async (
			action: string,
			runner: () => Promise<unknown>,
			successMessage: string,
		) => {
			if (!canonicalExecutionId) return;
			setPendingAction(action);
			try {
				await runner();
				toast.success(successMessage);
				load();
			} catch (err) {
				toast.error(
					`Failed to ${action}: ${err instanceof Error ? err.message : "Unknown error"}`,
				);
			} finally {
				setPendingAction(null);
			}
		},
		[canonicalExecutionId, load],
	);

	const agentStream = useAgentStream({
		executionId: executionId ?? null,
		enabled: Boolean(executionId),
	});

	useEffect(() => {
		const normalized = effectiveStatus.toLowerCase();
		if (!["running", "pending"].includes(normalized)) {
			return;
		}

		const interval = setInterval(() => {
			load();
		}, 3000);

		return () => clearInterval(interval);
	}, [effectiveStatus, load]);

	useEffect(() => {
		const eid = details?.execution.id ?? executionId;
		if (!eid) return;
		void api.workflow
			.getExecutionBrowserArtifacts(eid)
			.then((r) => setBrowserArtifactCount(r.count))
			.catch(() => {});
	}, [details?.execution.id, executionId, effectiveStatus]);

	useEffect(() => {
		if (!workflowId || !executionId || !details?.execution.id) {
			return;
		}
		if (details.execution.id === executionId) {
			return;
		}
		const query = searchParams.toString();
		router.replace(
			`/workflows/${workflowId}/runs/${details.execution.id}${query ? `?${query}` : ""}`,
			{ scroll: false },
		);
	}, [details?.execution.id, executionId, router, searchParams, workflowId]);

	const activeTab = normalizeTab(searchParams.get("tab"));
	const selectedFilePath = searchParams.get("file");
	const selectedLogId = searchParams.get("logId");
	const selectedNodeId = searchParams.get("nodeId");
	const selectedTraceId = searchParams.get("traceId");
	const selectedSpanId = searchParams.get("spanId");

	const updateQuery = useCallback(
		(updates: Record<string, string | null | undefined>) => {
			const nextParams = new URLSearchParams(searchParams.toString());
			for (const [key, value] of Object.entries(updates)) {
				if (value && value.trim()) {
					nextParams.set(key, value);
				} else {
					nextParams.delete(key);
				}
			}
			const currentQuery = searchParams.toString();
			const nextQuery = nextParams.toString();
			if (currentQuery === nextQuery) {
				return;
			}
			router.replace(nextQuery ? `${pathname}?${nextQuery}` : pathname, {
				scroll: false,
			});
		},
		[pathname, router, searchParams],
	);

	const monitorSummary = useMemo(() => {
		if (!monitorExecution) {
			return undefined;
		}
		const parsedOutput = parseDaprAgentOutput(monitorExecution.output);
		return {
			eventCount: monitorExecution.executionHistory.length,
			workflowType: monitorExecution.workflowType,
			currentPhase:
				monitorExecution.customStatus?.phase ??
				monitorExecution.daprStatus?.phase ??
				undefined,
			taskCount: parsedOutput?.tasks?.length ?? 0,
		};
	}, [monitorExecution]);

	const executionFileChangeData = useMemo(
		() => parseExecutionFileChangeData(details?.execution.output),
		[details?.execution.output],
	);

	const executionTraceIds = useMemo(() => {
		const ids = new Set<string>();
		const push = (value: string | null | undefined) => {
			if (!value) {
				return;
			}
			const normalized = value.trim();
			if (normalized) {
				ids.add(normalized);
			}
		};

		for (const run of details?.agentRuns ?? []) {
			push(readTraceIdFromUnknown(run.result));
		}

		for (const progress of Object.values(
			runtimeStatus?.agentProgressByNode ?? {},
		)) {
			push(progress.traceId);
		}

		push(details?.runtime?.traceId ?? null);
		push(runtimeStatus?.traceId);
		for (const traceId of extractExecutionTraceIds(details?.execution.output)) {
			push(traceId);
		}

		return Array.from(ids);
	}, [
		details?.agentRuns,
		details?.execution.output,
		details?.runtime?.traceId,
		runtimeStatus?.agentProgressByNode,
		runtimeStatus?.traceId,
	]);

	if (isLoading && !details) {
		return (
			<div className="container mx-auto py-6">
				<div className="rounded-lg border p-6 text-muted-foreground text-sm">
					Loading run workspace...
				</div>
			</div>
		);
	}

	if (!details || error) {
		return (
			<div className="container mx-auto space-y-4 py-6">
				<div className="flex items-center gap-3">
					<SidebarToggle />
					<Button asChild size="sm" variant="outline">
						<Link href={`/workflows/${workflowId}/runs`}>
							<ArrowLeft className="mr-2 h-4 w-4" />
							Back to runs
						</Link>
					</Button>
				</div>
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
					{error ?? "Run details not found"}
				</div>
			</div>
		);
	}

	return (
		<div className="container mx-auto py-3">
			<Tabs
				className="space-y-3"
				onValueChange={(value) => {
					const nextTab = normalizeTab(value);
					updateQuery({
						tab: nextTab,
						file: nextTab === "changes" ? selectedFilePath : null,
						logId: nextTab === "activities" ? selectedLogId : null,
						nodeId: nextTab === "timeline" ? selectedNodeId : null,
						traceId: nextTab === "trace" ? selectedTraceId : null,
						spanId: nextTab === "trace" ? selectedSpanId : null,
					});
				}}
				value={activeTab}
			>
				<div className="sticky top-0 z-20 rounded-lg border bg-background/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
					<div className="flex flex-wrap items-center justify-between gap-3">
						<div className="space-y-1">
							<div className="flex items-center gap-2">
								<SidebarToggle />
								<Button asChild size="sm" variant="outline">
									<Link href={`/workflows/${workflowId}/runs`}>
										<ArrowLeft className="mr-2 h-4 w-4" />
										Back
									</Link>
								</Button>
								<h1 className="font-semibold text-base sm:text-lg">
									{workflowName}
								</h1>
								<ExecutionStatusBadge status={effectiveStatus} />
								{agentStream.isConnected && (
									<span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
										<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
										Live
									</span>
								)}
								{agentStream.activeToolName && (
									<span className="text-xs text-muted-foreground">
										{agentStream.activeToolName}
									</span>
								)}
							</div>
							<p className="font-mono text-muted-foreground text-xs">
								Run ID: {details.execution.id}
							</p>
						</div>

						<div className="flex flex-wrap items-center gap-2">
							{canPause && (
								<Button
									disabled={pendingAction !== null}
									onClick={() =>
										runAction(
											"pause",
											() => api.dapr.pause(canonicalExecutionId!),
											"Workflow paused",
										)
									}
									size="sm"
									variant="outline"
								>
									<Pause className="mr-2 h-4 w-4" />
									Pause
								</Button>
							)}
							{canResume && (
								<Button
									disabled={pendingAction !== null}
									onClick={() =>
										runAction(
											"resume",
											() => api.dapr.resume(canonicalExecutionId!),
											"Workflow resumed",
										)
									}
									size="sm"
									variant="outline"
								>
									<Play className="mr-2 h-4 w-4" />
									Resume
								</Button>
							)}
							{canTerminate && (
								<Button
									disabled={pendingAction !== null}
									onClick={() =>
										runAction(
											"terminate",
											() =>
												api.dapr.terminate(
													canonicalExecutionId!,
													"Terminated from run detail page",
												),
											"Workflow terminated",
										)
									}
									size="sm"
									variant="destructive"
								>
									<Square className="mr-2 h-4 w-4" />
									Terminate
								</Button>
							)}
							<Button asChild size="sm" variant="outline">
								<Link href={`/monitor/${details.execution.id}`}>Monitor</Link>
							</Button>
							<Button asChild size="sm" variant="outline">
								<Link
									href={`/observability?entityId=${encodeURIComponent(workflowId)}&search=${encodeURIComponent(details.execution.id)}`}
								>
									Observability
								</Link>
							</Button>
							<Button onClick={load} size="sm" variant="outline">
								<RefreshCw className="mr-2 h-4 w-4" />
								Refresh
							</Button>
						</div>
					</div>

					<div className="mt-2 flex flex-col gap-2 border-t pt-2 sm:flex-row sm:items-center sm:justify-between">
						<div className="-mx-1 overflow-x-auto px-1">
							<TabsList className="h-8 w-max min-w-full sm:min-w-0">
								<TabsTrigger className="h-7 px-2.5 text-xs" value="overview">
									Overview
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="timeline">
									Timeline ({details.timeline?.length ?? 0})
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="activities">
									Activities ({details.logs.length})
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="child-runs">
									Child Runs ({details.agentRuns?.length ?? 0})
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="artifacts">
									Artifacts (
									{(details.planArtifacts?.length ?? 0) +
										(details.externalEvents?.length ?? 0) +
										browserArtifactCount}
									)
									{browserArtifactCount > 0 && (
										<span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
									)}
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="changes">
									Changes
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="trace">
									Trace
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="sandbox">
									Sandbox
								</TabsTrigger>
							</TabsList>
						</div>
						<div className="hidden items-center gap-3 text-muted-foreground text-xs sm:flex">
							<span>
								Started:{" "}
								{new Date(details.execution.startedAt).toLocaleString()}
							</span>
							<span>Duration: {details.execution.duration ?? "-"}</span>
						</div>
					</div>
				</div>

				<TabsContent className="mt-0 space-y-3" value="overview">
					<RunOverviewTab
						execution={details.execution}
						monitorSummary={monitorSummary}
						runtimeStatus={runtimeStatus}
						workflowId={workflowId}
						durableSummary={{
							timelineCount: details.timeline?.length ?? 0,
							childRunCount: details.agentRuns?.length ?? 0,
							artifactCount: details.planArtifacts?.length ?? 0,
							externalEventCount: details.externalEvents?.length ?? 0,
							consistency: details.consistency,
						}}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="timeline">
					{isRunActive &&
						(agentStream.isLlmStreaming || agentStream.llmTokenBuffer) && (
							<AgentLlmStream
								tokenBuffer={agentStream.llmTokenBuffer}
								isStreaming={agentStream.isLlmStreaming}
							/>
						)}
					{isRunActive &&
						(agentStream.sandboxOutputs.length > 0 ||
							agentStream.activeSandboxCommand) && (
							<SandboxOutput
								outputs={agentStream.sandboxOutputs}
								activeSandboxLines={agentStream.activeSandboxLines}
								activeSandboxCommand={agentStream.activeSandboxCommand}
							/>
						)}
					<RunTimelineTab
						agentStreamEvents={agentStream.events}
						nodeIdFilter={selectedNodeId}
						timeline={details.timeline ?? []}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="activities">
					<RunLogsTab
						logs={details.logs}
						onSelectedLogIdChange={(logId) =>
							updateQuery({ logId, tab: "activities" })
						}
						selectedLogId={selectedLogId}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="child-runs">
					<RunChildRunsTab agentRuns={details.agentRuns ?? []} />
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="artifacts">
					<RunArtifactsTab
						executionId={canonicalExecutionId}
						externalEvents={details.externalEvents ?? []}
						planArtifacts={details.planArtifacts ?? []}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="changes">
					<ExecutionChangesPanel
						executionId={canonicalExecutionId}
						fallbackData={executionFileChangeData}
						initialSelectedFilePath={selectedFilePath}
						onSelectedFilePathChange={(path) =>
							updateQuery({ file: path, tab: "changes" })
						}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="trace">
					<RunTraceTab
						daprInstanceId={details.execution.daprInstanceId}
						executionId={canonicalExecutionId}
						onSelectedSpanIdChange={(spanId) =>
							updateQuery({ spanId, tab: "trace" })
						}
						onSelectedTraceIdChange={(traceId) =>
							updateQuery({ traceId, spanId: null, tab: "trace" })
						}
						selectedSpanId={selectedSpanId}
						selectedTraceId={selectedTraceId}
						traceIds={executionTraceIds}
						workflowId={workflowId}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="sandbox">
					<RunSandboxTab
						executionId={canonicalExecutionId}
						workflowId={workflowId}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
