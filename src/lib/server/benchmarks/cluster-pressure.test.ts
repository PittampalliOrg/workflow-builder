import { afterEach, describe, expect, it, vi } from "vitest";
import { __benchmarkClusterPressureForTest } from "./cluster-pressure";

const baseSnapshot = {
	sampledAt: new Date().toISOString(),
	cluster: "dev",
	flavor: "dev-benchmark",
	resources: [],
	queues: [
		{
			name: "benchmark-fast",
			cohort: "benchmarks",
			flavor: "dev-benchmark",
			active: true,
			admittedWorkloads: 0,
			pendingWorkloads: 0,
			reservingWorkloads: 0,
			admissionWaitP50Seconds: null,
			admissionWaitP95Seconds: null,
			resources: [],
		},
	],
	localQueues: 0,
	sessionCapacity: [],
	blockedWorkloads: [],
	nodePressure: {},
	criticalHealth: [],
	recentPreemptions: 0,
	warnings: [],
};

describe("benchmark cluster pressure", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("reduces admission when PSI coverage is incomplete", () => {
		const pressure =
			__benchmarkClusterPressureForTest.summarizeBenchmarkClusterPressure({
				result: {
					available: true,
					snapshot: {
						...baseSnapshot,
						psi: {
							coverage: {
								expectedNodes: ["worker-1", "worker-2"],
								sampledNodes: ["worker-1"],
								missingNodes: ["worker-2"],
								complete: false,
								errorsByNode: { "worker-2": "timed out" },
							},
						},
					},
					error: null,
				},
				queueName: "benchmark-fast",
			});

		expect(pressure).toMatchObject({
			pressure: true,
			hardBlock: false,
			reductionFactor: 0.5,
			psiCoverageComplete: false,
			psiMissingNodes: ["worker-2"],
			reasons: ["cluster_pressure"],
		});
	});

	it("blocks starts when full memory pressure crosses the threshold", () => {
		const pressure =
			__benchmarkClusterPressureForTest.summarizeBenchmarkClusterPressure({
				result: {
					available: true,
					snapshot: {
						...baseSnapshot,
						psi: {
							memory: {
								some: { avg60: 15 },
								full: { avg60: 6 },
							},
							coverage: {
								expectedNodes: ["worker-1"],
								sampledNodes: ["worker-1"],
								missingNodes: [],
								complete: true,
								errorsByNode: {},
							},
						},
					},
					error: null,
				},
				queueName: "benchmark-fast",
			});

		expect(pressure.hardBlock).toBe(true);
		expect(pressure.reasons).toContain("psi_memory_pressure");
		expect(pressure.memoryFullAvg60).toBe(6);
	});

	it("blocks starts when the target ClusterQueue is inactive", () => {
		const pressure =
			__benchmarkClusterPressureForTest.summarizeBenchmarkClusterPressure({
				result: {
					available: true,
					snapshot: {
						...baseSnapshot,
						queues: [
							{
								...baseSnapshot.queues[0],
								active: false,
							},
						],
					},
					error: null,
				},
				queueName: "benchmark-fast",
			});

		expect(pressure).toMatchObject({
			hardBlock: true,
			queueActive: false,
			reasons: ["kueue_capacity"],
		});
	});
});
