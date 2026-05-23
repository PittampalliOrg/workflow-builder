import {
	queueFromObserver,
} from "$lib/server/capacity/observer";
import type {
	CapacityObserverResult,
	CapacityPsiBlock,
	CapacityPsiCoverage,
	CapacityPsiSnapshot,
} from "$lib/types/capacity";
import type { BenchmarkCapacityLimiter } from "./runtime-capacity";

export type BenchmarkClusterPressureSnapshot = {
	available: boolean;
	cluster: string | null;
	sampledAt: string | null;
	sampleAgeSeconds: number | null;
	stale: boolean;
	queueName: string | null;
	queueActive: boolean | null;
	pendingWorkloads: number | null;
	admittedWorkloads: number | null;
	psiCoverageComplete: boolean | null;
	psiExpectedNodes: string[];
	psiSampledNodes: string[];
	psiMissingNodes: string[];
	cpuSomeAvg60: number | null;
	memorySomeAvg60: number | null;
	memoryFullAvg60: number | null;
	ioFullAvg60: number | null;
	hardBlock: boolean;
	reductionFactor: number;
	pressure: boolean;
	reasons: BenchmarkCapacityLimiter[];
	error: string | null;
};

const DEFAULT_MAX_SAMPLE_AGE_SECONDS = 120;
const DEFAULT_MEMORY_SOME_REDUCE_THRESHOLD = 10;
const DEFAULT_MEMORY_FULL_BLOCK_THRESHOLD = 5;
const DEFAULT_IO_FULL_BLOCK_THRESHOLD = 10;
const DEFAULT_CPU_SOME_REDUCE_THRESHOLD = 50;

function envNumber(name: string, fallback: number): number {
	const parsed = Number.parseFloat(process.env[name] ?? "");
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function maxSampleAgeSeconds(): number {
	return envNumber(
		"BENCHMARK_CLUSTER_PRESSURE_MAX_SAMPLE_AGE_SECONDS",
		DEFAULT_MAX_SAMPLE_AGE_SECONDS,
	);
}

function psiValue(
	psi: CapacityPsiSnapshot | undefined,
	resource: "cpu" | "memory" | "io",
	stall: "some" | "full",
	window: "avg10" | "avg60" | "avg300" = "avg60",
): number | null {
	const block = psi?.[resource] as CapacityPsiBlock | undefined;
	const value = block?.[stall]?.[window];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sampleAgeSeconds(sampledAt: string | null): number | null {
	if (!sampledAt) return null;
	const parsed = Date.parse(sampledAt);
	if (!Number.isFinite(parsed)) return null;
	return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function coverageFields(coverage: CapacityPsiCoverage | undefined): {
	complete: boolean | null;
	expected: string[];
	sampled: string[];
	missing: string[];
} {
	return {
		complete: typeof coverage?.complete === "boolean" ? coverage.complete : null,
		expected: Array.isArray(coverage?.expectedNodes)
			? coverage.expectedNodes
			: [],
		sampled: Array.isArray(coverage?.sampledNodes) ? coverage.sampledNodes : [],
		missing: Array.isArray(coverage?.missingNodes) ? coverage.missingNodes : [],
	};
}

function addReason(
	reasons: BenchmarkCapacityLimiter[],
	reason: BenchmarkCapacityLimiter,
) {
	if (!reasons.includes(reason)) reasons.push(reason);
}

export function summarizeBenchmarkClusterPressure(params: {
	result: CapacityObserverResult;
	queueName?: string | null;
}): BenchmarkClusterPressureSnapshot {
	const reasons: BenchmarkCapacityLimiter[] = [];
	let reductionFactor = 1;
	let hardBlock = false;
	const maxAge = maxSampleAgeSeconds();

	if (!params.result.available) {
		addReason(reasons, "cluster_pressure");
		return {
			available: false,
			cluster: null,
			sampledAt: null,
			sampleAgeSeconds: null,
			stale: true,
			queueName: params.queueName ?? null,
			queueActive: null,
			pendingWorkloads: null,
			admittedWorkloads: null,
			psiCoverageComplete: null,
			psiExpectedNodes: [],
			psiSampledNodes: [],
			psiMissingNodes: [],
			cpuSomeAvg60: null,
			memorySomeAvg60: null,
			memoryFullAvg60: null,
			ioFullAvg60: null,
			hardBlock: false,
			reductionFactor: 0.5,
			pressure: true,
			reasons,
			error: params.result.error,
		};
	}

	const snapshot = params.result.snapshot;
	const sampledAt = snapshot.sampledAt;
	const age = sampleAgeSeconds(sampledAt);
	const stale = age == null || age > maxAge;
	if (stale) {
		addReason(reasons, "cluster_pressure");
		reductionFactor = Math.min(reductionFactor, 0.5);
	}

	const queue = queueFromObserver(snapshot, params.queueName);
	if (queue?.active === false) {
		addReason(reasons, "kueue_capacity");
		hardBlock = true;
	}

	const coverage = coverageFields(snapshot.psi?.coverage);
	if (coverage.complete === false) {
		addReason(reasons, "cluster_pressure");
		reductionFactor = Math.min(reductionFactor, 0.5);
	}

	const cpuSomeAvg60 = psiValue(snapshot.psi, "cpu", "some");
	const memorySomeAvg60 = psiValue(snapshot.psi, "memory", "some");
	const memoryFullAvg60 = psiValue(snapshot.psi, "memory", "full");
	const ioFullAvg60 = psiValue(snapshot.psi, "io", "full");

	if (
		memoryFullAvg60 != null &&
		memoryFullAvg60 >=
			envNumber(
				"BENCHMARK_CLUSTER_PRESSURE_MEMORY_FULL_BLOCK_AVG60",
				DEFAULT_MEMORY_FULL_BLOCK_THRESHOLD,
			)
	) {
		addReason(reasons, "psi_memory_pressure");
		hardBlock = true;
	}
	if (
		ioFullAvg60 != null &&
		ioFullAvg60 >=
			envNumber(
				"BENCHMARK_CLUSTER_PRESSURE_IO_FULL_BLOCK_AVG60",
				DEFAULT_IO_FULL_BLOCK_THRESHOLD,
			)
	) {
		addReason(reasons, "psi_io_pressure");
		hardBlock = true;
	}
	if (
		memorySomeAvg60 != null &&
		memorySomeAvg60 >=
			envNumber(
				"BENCHMARK_CLUSTER_PRESSURE_MEMORY_SOME_REDUCE_AVG60",
				DEFAULT_MEMORY_SOME_REDUCE_THRESHOLD,
			)
	) {
		addReason(reasons, "psi_memory_pressure");
		reductionFactor = Math.min(reductionFactor, 0.5);
	}
	if (
		cpuSomeAvg60 != null &&
		cpuSomeAvg60 >=
			envNumber(
				"BENCHMARK_CLUSTER_PRESSURE_CPU_SOME_REDUCE_AVG60",
				DEFAULT_CPU_SOME_REDUCE_THRESHOLD,
			)
	) {
		addReason(reasons, "psi_cpu_pressure");
		reductionFactor = Math.min(reductionFactor, 0.75);
	}

	return {
		available: true,
		cluster: snapshot.cluster,
		sampledAt,
		sampleAgeSeconds: age,
		stale,
		queueName: queue?.name ?? params.queueName ?? null,
		queueActive: typeof queue?.active === "boolean" ? queue.active : null,
		pendingWorkloads: queue?.pendingWorkloads ?? null,
		admittedWorkloads: queue?.admittedWorkloads ?? null,
		psiCoverageComplete: coverage.complete,
		psiExpectedNodes: coverage.expected,
		psiSampledNodes: coverage.sampled,
		psiMissingNodes: coverage.missing,
		cpuSomeAvg60,
		memorySomeAvg60,
		memoryFullAvg60,
		ioFullAvg60,
		hardBlock,
		reductionFactor,
		pressure: hardBlock || reductionFactor < 1 || reasons.length > 0,
		reasons,
		error: null,
	};
}

export const __benchmarkClusterPressureForTest = {
	summarizeBenchmarkClusterPressure,
};
