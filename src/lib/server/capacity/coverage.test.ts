import { afterEach, describe, expect, it, vi } from "vitest";
import { __capacityCoverageForTest } from "./coverage";
import type { CapacityObserverResult } from "$lib/types/capacity";

afterEach(() => {
	vi.useRealTimers();
});

describe("capacity coverage summary", () => {
	it("classifies known pod-producing paths as Kueue-managed when queues exist", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-05-21T12:00:00Z"));
		const coverage =
			__capacityCoverageForTest.buildCapacityCoverageSummary(observerResult());

		expect(coverage.generatedAt).toBe("2026-05-21T12:00:00.000Z");
		expect(coverage.gaps).toEqual([]);
		expect(coverage.counts.kueue_managed).toBeGreaterThanOrEqual(6);
		expect(coverage.paths.find((path) => path.id === "swebench-inference")).toMatchObject({
			status: "kueue_managed",
			queue: "benchmark-fast",
		});
		expect(coverage.kubernetes136.find((feature) => feature.id === "psi-metrics")).toMatchObject({
			status: "available",
			required: true,
		});
	});

	it("turns missing queue-backed paths into explicit gaps", () => {
		const coverage = __capacityCoverageForTest.buildCapacityCoverageSummary(
			observerResult(["interactive-agent"]),
		);

		expect(coverage.gaps.map((path) => path.id)).toContain("swebench-inference");
		expect(coverage.counts.gap).toBeGreaterThan(0);
	});

	it("marks PSI as needs-audit when coverage is partial", () => {
		const result = observerResult();
		if (result.available) {
			result.snapshot.psi = {
				memory: { some: { avg60: 0.5 } },
				coverage: {
					expectedNodes: ["worker-1", "worker-2"],
					sampledNodes: ["worker-1"],
					missingNodes: ["worker-2"],
					complete: false,
					errorsByNode: { "worker-2": "timed out" },
				},
			};
		}
		const coverage = __capacityCoverageForTest.buildCapacityCoverageSummary(result);

		expect(coverage.kubernetes136.find((feature) => feature.id === "psi-metrics")).toMatchObject({
			status: "needs_audit",
			message: expect.stringContaining("missing telemetry"),
		});
	});
});

function observerResult(
	queueNames = [
		"interactive-agent",
		"benchmark-fast",
		"benchmark-eval",
		"background-warm",
		"secure-gvisor",
	],
): CapacityObserverResult {
	return {
		available: true,
		error: null,
		snapshot: {
			sampledAt: "2026-05-21T12:00:00Z",
			cluster: "dev",
			flavor: "dev-benchmark",
			resources: [],
			queues: queueNames.map((name) => ({
				name,
				cohort: "agent-platform",
				flavor: "dev-benchmark",
				admittedWorkloads: 0,
				pendingWorkloads: 0,
				reservingWorkloads: 0,
				admissionWaitP50Seconds: null,
				admissionWaitP95Seconds: null,
				resources: [],
			})),
			localQueues: queueNames.length,
			sessionCapacity: [],
			blockedWorkloads: [],
			nodePressure: {},
			criticalHealth: [],
			recentPreemptions: 0,
			psi: { memory: { some: { avg60: 0 } } },
			warnings: [],
		},
	};
}
