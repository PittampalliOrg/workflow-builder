// Failure context: snapshots Kueue / Dapr / agent-sandbox platform state
// inside the window a benchmark run was alive. Drives the "Platform state at
// failure time" panel on the run-detail page — only renders for terminal
// failure statuses.

import {
	queryCounterDelta,
	queryGaugeLatest,
	queryHistogramPercentiles,
	type CounterDeltaResult,
	type GaugeLatestResult,
	type HistogramPercentileResult,
	type MetricFilter,
	type TimeRange,
} from "$lib/server/otel/metrics";

export type RunFailureContextSource = {
	status: unknown;
	startedAt: Date | null;
	completedAt: Date | null;
	createdAt: Date;
};

export type RunFailureContextMetricReader = {
	queryGaugeLatest(
		metric: string,
		range: TimeRange,
		filters?: MetricFilter,
	): Promise<GaugeLatestResult>;
	queryCounterDelta(
		metric: string,
		range: TimeRange,
		filters?: MetricFilter,
	): Promise<CounterDeltaResult>;
	queryHistogramPercentiles(
		metric: string,
		percentiles: number[],
		range: TimeRange,
		filters?: MetricFilter,
	): Promise<HistogramPercentileResult>;
};

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

const defaultMetrics: RunFailureContextMetricReader = {
	queryGaugeLatest,
	queryCounterDelta,
	queryHistogramPercentiles,
};

export function isTerminalFailureStatus(status: unknown): boolean {
	return typeof status === "string" && TERMINAL_FAILURE_STATUSES.has(status);
}

export async function buildRunFailureContext(
	run: RunFailureContextSource,
	options: {
		cluster?: string;
		metrics?: RunFailureContextMetricReader;
		now?: () => Date;
	} = {},
): Promise<RunFailureContext | null> {
	if (!isTerminalFailureStatus(run.status)) return null;

	const cluster = options.cluster ?? DEFAULT_CLUSTER;
	const metrics = options.metrics ?? defaultMetrics;
	const start = run.startedAt ?? run.createdAt;
	const end = run.completedAt ?? options.now?.() ?? new Date();
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
		metrics.queryGaugeLatest("kueue_pending_workloads", range, {
			cluster,
		}).catch(() => null),
		metrics.queryCounterDelta("kueue_preempted_workloads_total", range, {
			cluster,
		}).catch(() => ({ delta: 0, samples: 0 })),
		metrics.queryHistogramPercentiles(
			"kueue_admission_wait_time_seconds",
			[0.95],
			range,
			{ cluster },
		).catch(() => null),
		metrics.queryCounterDelta("controller_runtime_reconcile_errors_total", range, {
			cluster,
			attribute: { controller: "sandbox" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		metrics.queryCounterDelta("dapr_runtime_workflow_execution_count", range, {
			cluster,
			attribute: { status: "failed" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		metrics.queryCounterDelta("dapr_runtime_workflow_execution_count", range, {
			cluster,
			attribute: { status: "recoverable" },
		}).catch(() => ({ delta: 0, samples: 0 })),
		metrics.queryHistogramPercentiles(
			"dapr_runtime_workflow_scheduling_latency",
			[0.95],
			range,
			{ cluster },
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
		cluster,
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
