"use client";

import Link from "next/link";
import { useMemo } from "react";
import { ExecutionStatusBadge } from "@/components/workflow-runs/execution-status-badge";
import { Button } from "@/components/ui/button";
import {
	parseDaprAgentOutput,
	parseExecutionOutcomeSummary,
} from "@/lib/transforms/workflow-ui";
import type { DurableExecutionConsistency } from "@/lib/types/durable-timeline";

type RunExecution = {
	id: string;
	status: string;
	input: unknown;
	output: unknown;
	error: string | null;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
	daprInstanceId: string | null;
	phase: string | null;
	progress: number | null;
};

type RuntimeStatus = {
	status: string;
	runtimeStatus?: string | null;
	phase?: string | null;
	progress?: number | null;
	message?: string | null;
	currentNodeId?: string | null;
	currentNodeName?: string | null;
	approvalEventName?: string | null;
	nodeStatuses: Array<{
		nodeId: string;
		status: "pending" | "running" | "success" | "error";
	}>;
	consistency?: DurableExecutionConsistency;
} | null;

type MonitorSummary = {
	eventCount: number;
	workflowType?: string;
	currentPhase?: string;
};

type RunOverviewTabProps = {
	execution: RunExecution;
	runtimeStatus: RuntimeStatus;
	workflowId: string;
	monitorSummary?: MonitorSummary;
	durableSummary?: {
		timelineCount: number;
		childRunCount: number;
		artifactCount: number;
		externalEventCount: number;
		consistency?: DurableExecutionConsistency;
	};
};

function prettyJson(value: unknown): string {
	return JSON.stringify(value ?? {}, null, 2);
}

export function RunOverviewTab({
	execution,
	runtimeStatus,
	workflowId,
	monitorSummary,
	durableSummary,
}: RunOverviewTabProps) {
	const taskSummary = useMemo(() => {
		const parsed = parseDaprAgentOutput(execution.output);
		const tasks = parsed?.tasks ?? [];
		if (tasks.length === 0) {
			return { completed: 0, failed: 0, total: 0 };
		}
		return tasks.reduce(
			(acc, task) => {
				acc.total += 1;
				if (task.status === "completed") acc.completed += 1;
				if (task.status === "failed") acc.failed += 1;
				return acc;
			},
			{ completed: 0, failed: 0, total: 0 },
		);
	}, [execution.output]);

	const outcomeSummary = useMemo(
		() => parseExecutionOutcomeSummary(execution.output),
		[execution.output],
	);

	const observabilityLink = `/observability?entityId=${encodeURIComponent(workflowId)}&search=${encodeURIComponent(execution.id)}`;

	return (
		<div className="space-y-3">
			<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Status</p>
					<div className="mt-1">
						<ExecutionStatusBadge
							status={runtimeStatus?.status ?? execution.status}
						/>
					</div>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Started</p>
					<p className="mt-1 text-sm">
						{new Date(execution.startedAt).toLocaleString()}
					</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Duration</p>
					<p className="mt-1 text-sm">{execution.duration ?? "-"}</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Dapr Instance</p>
					<p className="mt-1 truncate font-mono text-sm">
						{execution.daprInstanceId ?? "-"}
					</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Monitor Events</p>
					<p className="mt-1 text-sm">{monitorSummary?.eventCount ?? "-"}</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Current Phase</p>
					<p className="mt-1 text-sm">
						{runtimeStatus?.phase ??
							monitorSummary?.currentPhase ??
							execution.phase ??
							"-"}
					</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Current Node</p>
					<p className="mt-1 text-sm">
						{runtimeStatus?.currentNodeName ?? "-"}
					</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Tasks Completed</p>
					<p className="mt-1 text-sm">
						{taskSummary.total > 0
							? `${taskSummary.completed}/${taskSummary.total}`
							: "-"}
					</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Tasks Failed</p>
					<p className="mt-1 text-sm">
						{taskSummary.total > 0 ? taskSummary.failed : "-"}
					</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Timeline Events</p>
					<p className="mt-1 text-sm">{durableSummary?.timelineCount ?? "-"}</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Child Runs</p>
					<p className="mt-1 text-sm">{durableSummary?.childRunCount ?? "-"}</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">Plan Artifacts</p>
					<p className="mt-1 text-sm">{durableSummary?.artifactCount ?? "-"}</p>
				</div>
				<div className="rounded-md border bg-muted/20 px-3 py-2">
					<p className="text-muted-foreground text-xs">External Events</p>
					<p className="mt-1 text-sm">
						{durableSummary?.externalEventCount ?? "-"}
					</p>
				</div>
			</div>

			{(durableSummary?.consistency?.statusDiverged ??
				runtimeStatus?.consistency?.statusDiverged) && (
				<div className="rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-amber-700 text-sm dark:text-amber-300">
					Runtime and DB execution state diverged. Runtime is shown as source of
					truth while the workflow is active.
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<Button asChild size="sm" variant="outline">
					<Link href={`/monitor/${execution.id}`}>Open Full Monitor</Link>
				</Button>
				<Button asChild size="sm" variant="outline">
					<Link href={observabilityLink}>Open Observability</Link>
				</Button>
			</div>

			{outcomeSummary && (
				<div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
					<div className="rounded-md border bg-muted/20 px-3 py-2">
						<p className="text-muted-foreground text-xs">Branch</p>
						<p className="mt-1 truncate font-mono text-sm">
							{outcomeSummary.branch ?? "-"}
						</p>
					</div>
					<div className="rounded-md border bg-muted/20 px-3 py-2">
						<p className="text-muted-foreground text-xs">Commit</p>
						<p className="mt-1 truncate font-mono text-sm">
							{outcomeSummary.commit ?? "-"}
						</p>
					</div>
					<div className="rounded-md border bg-muted/20 px-3 py-2">
						<p className="text-muted-foreground text-xs">Pull Request</p>
						{outcomeSummary.prUrl ? (
							<Link
								className="mt-1 block truncate text-primary text-sm underline-offset-2 hover:underline"
								href={outcomeSummary.prUrl}
								rel="noreferrer"
								target="_blank"
							>
								{`#${outcomeSummary.prNumber ?? "?"} (${outcomeSummary.prState ?? "unknown"})`}
							</Link>
						) : (
							<p className="mt-1 text-sm">-</p>
						)}
					</div>
					<div className="rounded-md border bg-muted/20 px-3 py-2">
						<p className="text-muted-foreground text-xs">Changed Files</p>
						<p className="mt-1 text-sm">
							{typeof outcomeSummary.changedFileCount === "number"
								? outcomeSummary.changedFileCount
								: "-"}
						</p>
					</div>
				</div>
			)}

			<div className="grid gap-3 lg:grid-cols-2">
				<div className="rounded-md border bg-background p-3">
					<p className="mb-2 font-medium text-sm">Input</p>
					<pre className="max-h-[300px] overflow-auto rounded bg-muted/60 p-2.5 font-mono text-xs">
						{prettyJson(execution.input)}
					</pre>
				</div>
				<div className="rounded-md border bg-background p-3">
					<p className="mb-2 font-medium text-sm">Output</p>
					<pre className="max-h-[300px] overflow-auto rounded bg-muted/60 p-2.5 font-mono text-xs">
						{prettyJson(execution.output)}
					</pre>
				</div>
			</div>

			{execution.error ? (
				<div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-destructive text-sm">
					{execution.error}
				</div>
			) : null}
		</div>
	);
}
