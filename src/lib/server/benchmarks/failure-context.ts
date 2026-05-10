// Failure context: snapshots Kueue / Dapr / agent-sandbox platform state
// inside the window a benchmark run was alive. Drives the "Platform state at
// failure time" panel on the run-detail page — only renders for terminal
// failure statuses.
//
// All four metric helpers come from $lib/server/otel/metrics. Best-effort:
// the page-load wraps this in .catch(() => null) so a ClickHouse outage
// doesn't gate the run-detail page.

import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkRuns } from "$lib/server/db/schema";
import {
	queryCounterDelta,
	queryGaugeLatest,
	queryHistogramPercentiles,
	type TimeRange,
} from "$lib/server/otel/metrics";

export type RunFailureContext = {
	windowFrom: string;
	windowTo: string;
	cluster: string | null;
	kueue: {
		pendingWorkloadsAtEnd: number | null;
		preemptionsInWindow: number;
		admissionWaitP95Ms: number | null;
	};
	agentSandbox: {
		reconcileErrorsInWindow: number;
	};
	dapr: {
		workflowFailedInWindow: number;
		workflowRecoverableInWindow: number;
		schedulingLatencyP95Ms: number | null;
	};
};

const TERMINAL_FAILURE_STATUSES = new Set([
	"failed",
	"error",
	"timeout",
	"cancelled",
]);

const DEFAULT_CLUSTER = process.env.METRICS_DEFAULT_CLUSTER ?? "dev";

export function isTerminalFailureStatus(status: unknown): boolean {
	return typeof status === "string" && TERMINAL_FAILURE_STATUSES.has(status);
}

export async function getRunFailureContext(
	runId: string,
): Promise<RunFailureContext | null> {
	if (!db) return null;

	const [run] = await db
		.select({
			id: benchmarkRuns.id,
			status: benchmarkRuns.status,
			startedAt: benchmarkRuns.startedAt,
			completedAt: benchmarkRuns.completedAt,
			createdAt: benchmarkRuns.createdAt,
		})
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run) return null;
	if (!isTerminalFailureStatus(run.status)) return null;

	const start = run.startedAt ?? run.createdAt;
	const end = run.completedAt ?? new Date();
	const range: TimeRange = {
		from: new Date(start.getTime() - 60_000),
		to: new Date(end.getTime() + 30_000),
	};

	const [
		pending,
		preemptions,
		admissionWait,
		reconcileErrors,
		workflowFailed,
		workflowRecoverable,
		schedulingLatency,
	] = await Promise.all([
		queryGaugeLatest("kueue_pending_workloads", range, {
			cluster: DEFAULT_CLUSTER,
		}).catch(() => null),
		queryCounterDelta("kueue_preempted_workloads_total", range, {
			cluster: DEFAULT_CLUSTER,
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryHistogramPercentiles(
			"kueue_admission_wait_time_seconds",
			[0.95],
			range,
			{ cluster: DEFAULT_CLUSTER },
		).catch(() => null),
		queryCounterDelta("controller_runtime_reconcile_errors_total", range, {
			cluster: DEFAULT_CLUSTER,
			attribute: { controller: "sandbox" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryCounterDelta("dapr_runtime_workflow_execution_count", range, {
			cluster: DEFAULT_CLUSTER,
			attribute: { status: "failed" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryCounterDelta("dapr_runtime_workflow_execution_count", range, {
			cluster: DEFAULT_CLUSTER,
			attribute: { status: "recoverable" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		queryHistogramPercentiles(
			"dapr_runtime_workflow_scheduling_latency",
			[0.95],
			range,
			{ cluster: DEFAULT_CLUSTER },
		).catch(() => null),
	]);

	const admissionP95Sec =
		admissionWait && admissionWait.count > 0
			? admissionWait.percentiles.p95
			: null;
	const schedulingP95Sec =
		schedulingLatency && schedulingLatency.count > 0
			? schedulingLatency.percentiles.p95
			: null;

	return {
		windowFrom: range.from.toISOString(),
		windowTo: range.to.toISOString(),
		cluster: DEFAULT_CLUSTER,
		kueue: {
			pendingWorkloadsAtEnd: pending ? Math.round(pending.value) : null,
			preemptionsInWindow: Math.round(preemptions.delta),
			admissionWaitP95Ms:
				admissionP95Sec !== null ? admissionP95Sec * 1000 : null,
		},
		agentSandbox: {
			reconcileErrorsInWindow: Math.round(reconcileErrors.delta),
		},
		dapr: {
			workflowFailedInWindow: Math.round(workflowFailed.delta),
			workflowRecoverableInWindow: Math.round(workflowRecoverable.delta),
			schedulingLatencyP95Ms:
				schedulingP95Sec !== null ? schedulingP95Sec * 1000 : null,
		},
	};
}
