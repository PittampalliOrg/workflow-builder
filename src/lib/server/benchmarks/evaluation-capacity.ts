import { kubeApiFetch } from "$lib/server/kube/client";
import {
	kueueCapacityFromClusterQueue,
	parseCpuMilli,
	parseMemoryBytes,
	type BenchmarkKueueCapacitySnapshot,
	type BenchmarkSandboxResourceProfile,
} from "./sandbox-capacity";
import type { BenchmarkClusterPressureSnapshot } from "./cluster-pressure";

export type BenchmarkEvaluationCapacitySnapshot = {
	requestedEvaluationConcurrency: number;
	effectiveEvaluationConcurrency: number;
	reason: string | null;
	clusterQueueName: string;
	kueue: BenchmarkKueueCapacitySnapshot | null;
	clusterPressure: BenchmarkClusterPressureSnapshot | null;
	error: string | null;
};

const DEFAULT_EVALUATION_CONCURRENCY = 24;
const MAX_EVALUATION_CONCURRENCY = 128;
const DEFAULT_EVAL_QUEUE = "benchmark-eval";
const DEFAULT_EVAL_REQUEST_CPU = "500m";
const DEFAULT_EVAL_REQUEST_MEMORY = "2Gi";
const DEFAULT_EVAL_REQUEST_EPHEMERAL_STORAGE = "0";

function positiveInt(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function clampPositive(value: unknown, fallback: number, max: number): number {
	return Math.max(1, Math.min(positiveInt(value) ?? fallback, max));
}

function queueNameFromEnv(): string {
	return (
		process.env.SWEBENCH_TEKTON_KUEUE_QUEUE_NAME?.trim() ||
		process.env.BENCHMARK_EVAL_KUEUE_CLUSTER_QUEUE?.trim() ||
		DEFAULT_EVAL_QUEUE
	);
}

function evalRunInstanceRequest(): BenchmarkSandboxResourceProfile {
	return {
		cpuMilli:
			parseCpuMilli(process.env.SWEBENCH_EVAL_RUN_INSTANCE_REQUEST_CPU) ??
			parseCpuMilli(DEFAULT_EVAL_REQUEST_CPU) ??
			500,
		memoryBytes:
			parseMemoryBytes(process.env.SWEBENCH_EVAL_RUN_INSTANCE_REQUEST_MEMORY) ??
			parseMemoryBytes(DEFAULT_EVAL_REQUEST_MEMORY) ??
			2 * 1024 * 1024 * 1024,
		ephemeralStorageBytes:
			parseMemoryBytes(
				process.env.SWEBENCH_EVAL_RUN_INSTANCE_REQUEST_EPHEMERAL_STORAGE,
			) ??
			parseMemoryBytes(DEFAULT_EVAL_REQUEST_EPHEMERAL_STORAGE) ??
			0,
	};
}

async function loadClusterQueue(
	clusterQueueName: string,
): Promise<unknown | null> {
	for (const version of ["v1beta2", "v1beta1"]) {
		const res = await kubeApiFetch(
			`/apis/kueue.x-k8s.io/${version}/clusterqueues/${encodeURIComponent(clusterQueueName)}`,
			{ retries: 0 },
		);
		if (res.ok) return await res.json();
	}
	return null;
}

export async function loadBenchmarkEvaluationKueueCapacitySnapshot(
	clusterQueueName = queueNameFromEnv(),
): Promise<BenchmarkKueueCapacitySnapshot | null> {
	const request = evalRunInstanceRequest();
	const clusterQueue = await loadClusterQueue(clusterQueueName);
	if (!clusterQueue) return null;
	return kueueCapacityFromClusterQueue(clusterQueue, request, {
		instanceRequest: request,
		instancePodCount: 1,
	});
}

export async function estimateBenchmarkEvaluationCapacity(input: {
	instanceCount: number;
	evaluationConcurrency?: unknown;
	clusterPressure?: BenchmarkClusterPressureSnapshot | null;
	clusterQueueName?: string | null;
}): Promise<BenchmarkEvaluationCapacitySnapshot> {
	const instanceLimit = Math.max(1, Math.floor(input.instanceCount));
	const requested = Math.min(
		clampPositive(
			input.evaluationConcurrency,
			positiveInt(process.env.SWEBENCH_EVAL_MAX_PARALLEL) ??
				DEFAULT_EVALUATION_CONCURRENCY,
			MAX_EVALUATION_CONCURRENCY,
		),
		instanceLimit,
	);
	const clusterQueueName = input.clusterQueueName?.trim() || queueNameFromEnv();
	let kueue: BenchmarkKueueCapacitySnapshot | null = null;
	let error: string | null = null;
	try {
		kueue = await loadBenchmarkEvaluationKueueCapacitySnapshot(clusterQueueName);
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
	}

	let effective = requested;
	let reason: string | null = null;
	if (kueue?.clusterQueueActive === false) {
		effective = 1;
		reason = "kueue_cluster_queue_inactive";
	} else if (kueue?.availableInstanceSlots != null) {
		const slots = Math.max(1, kueue.availableInstanceSlots);
		if (slots < effective) {
			effective = slots;
			reason = "kueue_eval_capacity";
		}
	}
	const pressure = input.clusterPressure ?? null;
	if (pressure?.hardBlock) {
		effective = 1;
		reason = "cluster_pressure";
	} else if (pressure?.pressure && pressure.reductionFactor < 1) {
		const adjusted = Math.max(1, Math.floor(effective * pressure.reductionFactor));
		if (adjusted < effective) {
			effective = adjusted;
			reason = "cluster_pressure";
		}
	}

	return {
		requestedEvaluationConcurrency: requested,
		effectiveEvaluationConcurrency: Math.max(1, Math.min(effective, instanceLimit)),
		reason,
		clusterQueueName,
		kueue,
		clusterPressure: pressure,
		error,
	};
}

export const __benchmarkEvaluationCapacityForTest = {
	evalRunInstanceRequest,
	queueNameFromEnv,
};
