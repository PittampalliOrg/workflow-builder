import type { BenchmarkSandboxCapacitySnapshot } from "./sandbox-capacity";

export type BenchmarkRuntimeCapacitySnapshot = {
	requestedConcurrency: number;
	effectiveConcurrency: number;
	runtimeClass: string;
	runtimeAppId: string;
	runtimeReplicas: number;
	perSidecarWorkflowLimit: number;
	daprWorkflowLimitPerSidecar: number;
	daprWorkflowEffectiveCapacity: number;
	agentWorkflowMaxActiveTurns: number | null;
	runtimeSlots: number;
	slotsPerReplica: number;
	maxActiveSessions: number;
	configuredMaxActiveSandboxes: number | null;
	maxActiveSandboxes: number | null;
	schedulableSandboxCapacity: number | null;
	sandboxCapacity: BenchmarkSandboxCapacitySnapshot | null;
	modelMaxActiveRequests: number | null;
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
	agentWorkflowMaxActiveTurns?: number | null;
	schedulableSandboxCapacity?: number | null;
	sandboxCapacity?: BenchmarkSandboxCapacitySnapshot | null;
	modelMaxActiveRequests?: number | null;
};

const DEFAULT_RUNTIME_CLASS = "coding";
const DEFAULT_REQUESTED_CONCURRENCY = 10;
const DEFAULT_MAX_ACTIVE_INFERENCE_INSTANCES = 56;
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

function nonNegativeInt(value: unknown): number | null {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number.parseInt(value, 10)
				: Number.NaN;
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
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

function envOptionalPositiveInt(...names: string[]): number | null {
	for (const name of names) {
		const value = positiveInt(process.env[name]);
		if (value) return value;
	}
	return null;
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

function configuredDaprWorkflowLimitPerSidecar(runtimeClass: string): number | null {
	const explicit =
		positiveInt(process.env.DAPR_WORKFLOW_MAX_CONCURRENT_WORKFLOW_INVOCATIONS) ??
		positiveInt(process.env.AGENT_RUNTIME_DAPR_WORKFLOW_LIMIT_PER_SIDECAR);
	if (explicit) return explicit;
	void runtimeClass;
	return null;
}

function requestedConcurrency(value: unknown): number {
	return (
		positiveInt(value) ??
		envPositiveInt("BENCHMARK_DEFAULT_CONCURRENCY", DEFAULT_REQUESTED_CONCURRENCY)
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
	const slotsPerReplica =
		positiveInt(input.slotsPerReplica) ??
		slotsByRuntimeClass()[runtimeClass] ??
		1;
	const daprWorkflowLimitPerSidecar =
		configuredDaprWorkflowLimitPerSidecar(runtimeClass) ?? slotsPerReplica;
	const runtimeSlots = Math.max(1, replicas * slotsPerReplica);
	const daprWorkflowEffectiveCapacity = Math.max(
		1,
		replicas * daprWorkflowLimitPerSidecar,
	);
	const configuredMaxActiveSessions = positiveInt(input.maxActiveSessions);
	const agentWorkflowMaxActiveTurns =
		positiveInt(input.agentWorkflowMaxActiveTurns) ??
		envOptionalPositiveInt(
			"BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS",
			"BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS",
		);
	const runtimeMax = Math.min(
		runtimeSlots,
		daprWorkflowEffectiveCapacity,
		configuredMaxActiveSessions ?? Number.POSITIVE_INFINITY,
	);
	const globalMax = envPositiveInt(
		"BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES",
		DEFAULT_MAX_ACTIVE_INFERENCE_INSTANCES,
	);
	const sandboxMax = positiveInt(process.env.BENCHMARK_MAX_ACTIVE_SANDBOXES);
	const schedulableSandboxCapacity = nonNegativeInt(
		input.schedulableSandboxCapacity ??
			(input.sandboxCapacity?.error
				? undefined
				: input.sandboxCapacity?.schedulableSandboxCapacity),
	);
	const totalSchedulableSandboxCapacity = nonNegativeInt(
		input.sandboxCapacity?.error
			? undefined
			: input.sandboxCapacity?.totalSchedulableSandboxCapacity,
	);
	const sandboxRunHeadroomLimit =
		sandboxMax == null && schedulableSandboxCapacity == null
			? null
			: Math.min(
					sandboxMax ?? Number.POSITIVE_INFINITY,
					schedulableSandboxCapacity ?? Number.POSITIVE_INFINITY,
				);
	const sandboxActiveLimit =
		sandboxMax == null &&
		totalSchedulableSandboxCapacity == null &&
		schedulableSandboxCapacity == null
			? null
			: Math.min(
					sandboxMax ?? Number.POSITIVE_INFINITY,
					totalSchedulableSandboxCapacity ??
						schedulableSandboxCapacity ??
						Number.POSITIVE_INFINITY,
				);
	const modelMax =
		positiveInt(input.modelMaxActiveRequests) ??
		positiveInt(process.env.BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS) ??
		positiveInt(process.env.BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS);
	const effective = Math.min(
		requested,
		selectedCount,
		runtimeMax,
		globalMax,
		agentWorkflowMaxActiveTurns ?? Number.POSITIVE_INFINITY,
		sandboxRunHeadroomLimit ?? Number.POSITIVE_INFINITY,
		modelMax ?? Number.POSITIVE_INFINITY,
	);
	const reasons: string[] = [];
	if (requested > selectedCount && effective === selectedCount) {
		reasons.push("selected_instance_count");
	}
	if (requested > runtimeMax && effective === runtimeMax) {
		reasons.push("runtime_capacity");
	}
	if (
		requested > daprWorkflowEffectiveCapacity &&
		effective === daprWorkflowEffectiveCapacity
	) {
		reasons.push("dapr_workflow_capacity");
	}
	if (requested > globalMax && effective === globalMax) {
		reasons.push("global_max");
	}
	if (
		agentWorkflowMaxActiveTurns &&
		requested > agentWorkflowMaxActiveTurns &&
		effective === agentWorkflowMaxActiveTurns
	) {
		reasons.push("agent_workflow_capacity");
	}
	if (sandboxMax && requested > sandboxMax && effective === sandboxMax) {
		reasons.push("sandbox_capacity");
	}
	if (
		schedulableSandboxCapacity != null &&
		requested > schedulableSandboxCapacity &&
		effective === schedulableSandboxCapacity
	) {
		reasons.push("sandbox_schedulable_capacity");
	}
	if (modelMax && requested > modelMax && effective === modelMax) {
		reasons.push("model_capacity");
	}

	return {
		requestedConcurrency: requested,
		effectiveConcurrency: effective,
		runtimeClass,
		runtimeAppId,
		runtimeReplicas: replicas,
		perSidecarWorkflowLimit: daprWorkflowLimitPerSidecar,
		daprWorkflowLimitPerSidecar,
		daprWorkflowEffectiveCapacity,
		agentWorkflowMaxActiveTurns,
		runtimeSlots,
		slotsPerReplica,
		maxActiveSessions: Math.min(
			runtimeMax,
			globalMax,
			modelMax ?? Number.POSITIVE_INFINITY,
		),
		configuredMaxActiveSandboxes: sandboxMax,
		maxActiveSandboxes: sandboxActiveLimit,
		schedulableSandboxCapacity,
		sandboxCapacity: input.sandboxCapacity ?? null,
		modelMaxActiveRequests: modelMax,
		capReason: reasons.length > 0 ? reasons.join("+") : null,
	};
}
