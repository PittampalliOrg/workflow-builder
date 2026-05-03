export type BenchmarkRuntimeCapacitySnapshot = {
	requestedConcurrency: number;
	effectiveConcurrency: number;
	runtimeClass: string;
	runtimeAppId: string;
	runtimeReplicas: number;
	perSidecarWorkflowLimit: number;
	slotsPerReplica: number;
	maxActiveSessions: number;
	maxActiveSandboxes: number | null;
	capReason: string | null;
};

export type BenchmarkRuntimeCapacityInput = {
	runtimeClass?: string | null;
	runtimeIsolation?: string | null;
	runtimeAppId?: string | null;
	poolMaxReplicas?: number | null;
	requestedInstanceCount: number;
	requestedConcurrency?: unknown;
	slotsPerReplica?: number | null;
	maxActiveSessions?: number | null;
};

const DEFAULT_RUNTIME_CLASS = "coding";
const DEFAULT_SLOTS_PER_REPLICA: Record<string, number> = {
	coding: 5,
	office: 2,
	browser: 1,
	testing: 2,
};

function positiveInt(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRuntimeClass(value: string | null | undefined): string {
	const normalized = (value ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return normalized || DEFAULT_RUNTIME_CLASS;
}

function envPositiveInt(name: string, fallback: number): number {
	return positiveInt(process.env[name]) ?? fallback;
}

function slotsByRuntimeClass(): Record<string, number> {
	const raw = process.env.AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON;
	if (!raw?.trim()) return DEFAULT_SLOTS_PER_REPLICA;
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return DEFAULT_SLOTS_PER_REPLICA;
		}
		const out = { ...DEFAULT_SLOTS_PER_REPLICA };
		for (const [key, value] of Object.entries(parsed)) {
			const runtimeClass = normalizeRuntimeClass(key);
			const slots = positiveInt(value);
			if (slots) out[runtimeClass] = slots;
		}
		return out;
	} catch {
		return DEFAULT_SLOTS_PER_REPLICA;
	}
}

function configuredPerSidecarWorkflowLimit(runtimeClass: string): number | null {
	const perClass = slotsByRuntimeClass()[runtimeClass];
	if (perClass) return perClass;
	return positiveInt(process.env.DAPR_WORKFLOW_MAX_CONCURRENT_WORKFLOW_INVOCATIONS);
}

function requestedConcurrency(value: unknown): number {
	return (
		positiveInt(value) ??
		envPositiveInt("BENCHMARK_DEFAULT_CONCURRENCY", 5)
	);
}

function runtimeReplicas(input: BenchmarkRuntimeCapacityInput): number {
	if (input.runtimeIsolation === "shared") {
		return (
			positiveInt(input.poolMaxReplicas) ??
			envPositiveInt("AGENT_RUNTIME_POOL_MAX_REPLICAS", 2)
		);
	}
	return 1;
}

export function estimateBenchmarkRuntimeCapacity(
	input: BenchmarkRuntimeCapacityInput,
): BenchmarkRuntimeCapacitySnapshot {
	const runtimeClass = normalizeRuntimeClass(input.runtimeClass);
	const runtimeAppId =
		typeof input.runtimeAppId === "string" && input.runtimeAppId.trim()
			? input.runtimeAppId.trim()
			: `agent-runtime-pool-${runtimeClass}`;
	const requested = requestedConcurrency(input.requestedConcurrency);
	const selectedCount = Math.max(1, Math.floor(input.requestedInstanceCount));
	const replicas = runtimeReplicas(input);
	const perSidecarWorkflowLimit =
		positiveInt(input.slotsPerReplica) ??
		configuredPerSidecarWorkflowLimit(runtimeClass) ??
		1;
	const runtimeSlots = Math.max(1, replicas * perSidecarWorkflowLimit);
	const configuredMaxActiveSessions = positiveInt(input.maxActiveSessions);
	const runtimeMax = configuredMaxActiveSessions
		? Math.min(runtimeSlots, configuredMaxActiveSessions)
		: runtimeSlots;
	const globalMax = envPositiveInt("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", 10);
	const sandboxMax = positiveInt(process.env.BENCHMARK_MAX_ACTIVE_SANDBOXES);
	const effective = Math.min(
		requested,
		selectedCount,
		runtimeMax,
		globalMax,
		sandboxMax ?? Number.POSITIVE_INFINITY,
	);
	const reasons: string[] = [];
	if (requested > selectedCount && effective === selectedCount) {
		reasons.push("selected_instance_count");
	}
	if (requested > runtimeMax && effective === runtimeMax) {
		reasons.push("runtime_capacity");
	}
	if (requested > globalMax && effective === globalMax) {
		reasons.push("global_max");
	}
	if (sandboxMax && requested > sandboxMax && effective === sandboxMax) {
		reasons.push("sandbox_capacity");
	}

	return {
		requestedConcurrency: requested,
		effectiveConcurrency: effective,
		runtimeClass,
		runtimeAppId,
		runtimeReplicas: replicas,
		perSidecarWorkflowLimit,
		slotsPerReplica: perSidecarWorkflowLimit,
		maxActiveSessions: Math.min(
			runtimeMax,
			globalMax,
			sandboxMax ?? Number.POSITIVE_INFINITY,
		),
		maxActiveSandboxes: sandboxMax,
		capReason: reasons.length > 0 ? reasons.join("+") : null,
	};
}
