"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import {
	useParams,
	usePathname,
	useRouter,
	useSearchParams,
} from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExecutionChangesPanel } from "@/components/workflow-runs/execution-changes-panel";
import { RunLogsTab } from "@/components/workflow-runs/run-logs-tab";
import { RunOverviewTab } from "@/components/workflow-runs/run-overview-tab";
import { RunTraceTab } from "@/components/workflow-runs/run-trace-tab";
import { ExecutionStatusBadge } from "@/components/workflow-runs/execution-status-badge";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useMonitorExecution } from "@/hooks/use-monitor-execution";
import { api } from "@/lib/api-client";
import { parseDaprAgentOutput } from "@/lib/transforms/workflow-ui";

type ExecutionLogsResponse = Awaited<
	ReturnType<typeof api.workflow.getExecutionLogs>
>;
type ExecutionStatusResponse = Awaited<
	ReturnType<typeof api.workflow.getExecutionStatus>
>;

type WorkspaceTab = "overview" | "changes" | "logs" | "trace";

const VALID_TABS: WorkspaceTab[] = ["overview", "changes", "logs", "trace"];

function normalizeTab(value: string | null): WorkspaceTab {
	if (!value) {
		return "overview";
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

	const activeTab = normalizeTab(searchParams.get("tab"));
	const selectedFilePath = searchParams.get("file");
	const selectedLogId = searchParams.get("logId");
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
						logId: nextTab === "logs" ? selectedLogId : null,
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
							</div>
							<p className="font-mono text-muted-foreground text-xs">
								Run ID: {details.execution.id}
							</p>
						</div>

						<div className="flex flex-wrap items-center gap-2">
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
								<TabsTrigger className="h-7 px-2.5 text-xs" value="changes">
									Changes
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="logs">
									Logs ({details.logs.length})
								</TabsTrigger>
								<TabsTrigger className="h-7 px-2.5 text-xs" value="trace">
									Trace
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
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="changes">
					<ExecutionChangesPanel
						executionId={executionId}
						initialSelectedFilePath={selectedFilePath}
						onSelectedFilePathChange={(path) =>
							updateQuery({ file: path, tab: "changes" })
						}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="logs">
					<RunLogsTab
						logs={details.logs}
						onSelectedLogIdChange={(logId) =>
							updateQuery({ logId, tab: "logs" })
						}
						selectedLogId={selectedLogId}
					/>
				</TabsContent>

				<TabsContent className="mt-0 space-y-3" value="trace">
					<RunTraceTab
						executionId={executionId}
						onSelectedSpanIdChange={(spanId) =>
							updateQuery({ spanId, tab: "trace" })
						}
						onSelectedTraceIdChange={(traceId) =>
							updateQuery({ traceId, spanId: null, tab: "trace" })
						}
						selectedSpanId={selectedSpanId}
						selectedTraceId={selectedTraceId}
						workflowId={workflowId}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}
