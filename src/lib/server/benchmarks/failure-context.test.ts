import { describe, expect, it, vi } from "vitest";
import {
	buildRunFailureContext,
	isTerminalFailureStatus,
	type RunFailureContextMetricReader,
} from "$lib/server/benchmarks/failure-context";

describe("benchmark failure context", () => {
	it("recognizes terminal failure statuses only", () => {
		expect(isTerminalFailureStatus("failed")).toBe(true);
		expect(isTerminalFailureStatus("error")).toBe(true);
		expect(isTerminalFailureStatus("timeout")).toBe(true);
		expect(isTerminalFailureStatus("cancelled")).toBe(true);
		expect(isTerminalFailureStatus("completed")).toBe(false);
		expect(isTerminalFailureStatus(null)).toBe(false);
	});

	it("returns null for non-failure runs without querying metrics", async () => {
		const metrics = fakeMetrics();

		await expect(
			buildRunFailureContext(
				{
					status: "completed",
					startedAt: new Date("2026-07-01T10:00:00.000Z"),
					completedAt: new Date("2026-07-01T10:05:00.000Z"),
					createdAt: new Date("2026-07-01T09:59:00.000Z"),
				},
				{ metrics },
			),
		).resolves.toBeNull();

		expect(metrics.queryGaugeLatest).not.toHaveBeenCalled();
		expect(metrics.queryCounterDelta).not.toHaveBeenCalled();
		expect(metrics.queryHistogramPercentiles).not.toHaveBeenCalled();
	});

	it("builds the platform metric window from the benchmark run timestamps", async () => {
		const metrics = fakeMetrics();

		await expect(
			buildRunFailureContext(
				{
					status: "failed",
					startedAt: new Date("2026-07-01T10:00:00.000Z"),
					completedAt: new Date("2026-07-01T10:10:00.000Z"),
					createdAt: new Date("2026-07-01T09:55:00.000Z"),
				},
				{ cluster: "ryzen", metrics },
			),
		).resolves.toEqual({
			windowFrom: "2026-07-01T09:59:00.000Z",
			windowTo: "2026-07-01T10:10:30.000Z",
			cluster: "ryzen",
			kueue: {
				pendingWorkloadsAtEnd: 4,
				preemptionsInWindow: 2,
				admissionWaitP95Ms: 1500,
			},
			agentSandbox: {
				reconcileErrorsInWindow: 5,
			},
			dapr: {
				workflowFailedInWindow: 1,
				workflowRecoverableInWindow: 7,
				schedulingLatencyP95Ms: 250,
			},
		});

		expect(metrics.queryGaugeLatest).toHaveBeenCalledWith(
			"kueue_pending_workloads",
			{
				from: new Date("2026-07-01T09:59:00.000Z"),
				to: new Date("2026-07-01T10:10:30.000Z"),
			},
			{ cluster: "ryzen" },
		);
	});

	it("keeps metric failures best-effort", async () => {
		const metrics = fakeMetrics({
			queryGaugeLatest: vi.fn(async () => {
				throw new Error("clickhouse down");
			}),
			queryCounterDelta: vi.fn(async () => {
				throw new Error("clickhouse down");
			}),
			queryHistogramPercentiles: vi.fn(async () => ({
				count: 0,
				sum: 0,
				percentiles: {},
			})),
		});

		await expect(
			buildRunFailureContext(
				{
					status: "timeout",
					startedAt: null,
					completedAt: null,
					createdAt: new Date("2026-07-01T09:55:00.000Z"),
				},
				{
					cluster: "dev",
					metrics,
					now: () => new Date("2026-07-01T10:05:00.000Z"),
				},
			),
		).resolves.toMatchObject({
			windowFrom: "2026-07-01T09:54:00.000Z",
			windowTo: "2026-07-01T10:05:30.000Z",
			kueue: {
				pendingWorkloadsAtEnd: null,
				preemptionsInWindow: 0,
				admissionWaitP95Ms: null,
			},
			agentSandbox: {
				reconcileErrorsInWindow: 0,
			},
			dapr: {
				workflowFailedInWindow: 0,
				workflowRecoverableInWindow: 0,
				schedulingLatencyP95Ms: null,
			},
		});
	});
});

function fakeMetrics(
	overrides: Partial<RunFailureContextMetricReader> = {},
): RunFailureContextMetricReader {
	return {
		queryGaugeLatest: vi.fn(async () => ({
			value: 3.6,
			t: new Date("2026-07-01T10:10:00.000Z"),
		})),
		queryCounterDelta: vi.fn(async (metric, _range, filters) => {
			if (metric === "kueue_preempted_workloads_total") {
				return { delta: 2.2, samples: 2 };
			}
			if (metric === "controller_runtime_reconcile_errors_total") {
				return { delta: 4.7, samples: 2 };
			}
			const status = filters?.attribute?.status;
			if (status === "failed") return { delta: 1.2, samples: 2 };
			if (status === "recoverable") return { delta: 6.6, samples: 2 };
			return { delta: 0, samples: 0 };
		}),
		queryHistogramPercentiles: vi.fn(async (metric) => ({
			count: 4,
			sum: 8,
			percentiles: {
				p95:
					metric === "kueue_admission_wait_time_seconds" ? 1.5 : 0.25,
			},
		})),
		...overrides,
	};
}
