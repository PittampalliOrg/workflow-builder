"use client";

import { ArrowLeft, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExecutionChangesPanel } from "@/components/workflow-runs/execution-changes-panel";
import { ExecutionLogsTable } from "@/components/workflow-runs/execution-logs-table";
import { ExecutionStatusBadge } from "@/components/workflow-runs/execution-status-badge";
import { SidebarToggle } from "@/components/sidebar-toggle";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

type ExecutionLogsResponse = Awaited<
	ReturnType<typeof api.workflow.getExecutionLogs>
>;
type ExecutionStatusResponse = Awaited<
	ReturnType<typeof api.workflow.getExecutionStatus>
>;

function prettyJson(value: unknown): string {
	return JSON.stringify(value ?? {}, null, 2);
}

export default function WorkflowRunDetailPage() {
	const params = useParams<{ workflowId: string; executionId: string }>();
	const workflowId = params.workflowId;
	const executionId = params.executionId;

	const [workflowName, setWorkflowName] = useState<string>("");
	const [details, setDetails] = useState<ExecutionLogsResponse | null>(null);
	const [runtimeStatus, setRuntimeStatus] =
		useState<ExecutionStatusResponse | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

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

	if (isLoading && !details) {
		return (
			<div className="container mx-auto py-6">
				<div className="rounded-lg border p-6 text-muted-foreground text-sm">
					Loading run details...
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
		<div className="container mx-auto space-y-6 py-6">
			<div className="flex items-start justify-between">
				<div className="space-y-2">
					<div className="flex items-center gap-3">
						<SidebarToggle />
						<Button asChild size="sm" variant="outline">
							<Link href={`/workflows/${workflowId}/runs`}>
								<ArrowLeft className="mr-2 h-4 w-4" />
								Back to runs
							</Link>
						</Button>
					</div>
					<h1 className="font-bold text-2xl">{workflowName}</h1>
					<p className="font-mono text-muted-foreground text-xs">
						Run ID: {details.execution.id}
					</p>
				</div>

				<Button onClick={load} size="sm" variant="outline">
					<RefreshCw className="mr-2 h-4 w-4" />
					Refresh
				</Button>
			</div>

			<div className="grid gap-4 rounded-lg border bg-background p-4 md:grid-cols-2 xl:grid-cols-4">
				<div>
					<p className="text-muted-foreground text-xs">Status</p>
					<div className="mt-1">
						<ExecutionStatusBadge status={effectiveStatus} />
					</div>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Started</p>
					<p className="mt-1 text-sm">
						{new Date(details.execution.startedAt).toLocaleString()}
					</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Duration</p>
					<p className="mt-1 text-sm">{details.execution.duration ?? "-"}</p>
				</div>
				<div>
					<p className="text-muted-foreground text-xs">Dapr Instance</p>
					<p className="mt-1 font-mono text-sm">
						{details.execution.daprInstanceId ?? "-"}
					</p>
				</div>
			</div>

			<div className="flex flex-wrap gap-2">
				<Button asChild size="sm" variant="outline">
					<Link href={`/monitor/${details.execution.id}`}>
						Open monitor view
					</Link>
				</Button>
				<Button asChild size="sm" variant="outline">
					<Link
						href={`/observability?entityId=${encodeURIComponent(workflowId)}&search=${encodeURIComponent(details.execution.id)}`}
					>
						Open observability traces
					</Link>
				</Button>
			</div>

			<div className="grid gap-4 lg:grid-cols-2">
				<div className="rounded-lg border bg-background p-4">
					<p className="mb-2 font-medium text-sm">Input</p>
					<pre className="max-h-[320px] overflow-auto rounded bg-muted p-3 font-mono text-xs">
						{prettyJson(details.execution.input)}
					</pre>
				</div>
				<div className="rounded-lg border bg-background p-4">
					<p className="mb-2 font-medium text-sm">Output</p>
					<pre className="max-h-[320px] overflow-auto rounded bg-muted p-3 font-mono text-xs">
						{prettyJson(details.execution.output)}
					</pre>
				</div>
			</div>

			<ExecutionChangesPanel executionId={executionId} />

			<div className="space-y-3">
				<h2 className="font-semibold text-lg">Execution logs</h2>
				<ExecutionLogsTable logs={details.logs} />
			</div>
		</div>
	);
}
