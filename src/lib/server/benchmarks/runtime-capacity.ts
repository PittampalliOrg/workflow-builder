import type { BenchmarkSandboxCapacitySnapshot } from "./sandbox-capacity";
import type {
	AgentHostDaprRuntimeSnapshot,
	ParentWorkflowRuntimeSnapshot,
} from "./dapr-workflow-capacity";
import type { BenchmarkClusterPressureSnapshot } from "./cluster-pressure";

export type BenchmarkCapacityLimiter =
	| "selected_instance_count"
	| "runtime_capacity"
	| "dapr_parent_capacity"
	| "dapr_workflow_capacity"
	| "dapr_runtime_pressure"
	| "agent_host_pressure"
	| "global_max"
	| "agent_workflow_capacity"
	| "sandbox_capacity"
	| "kueue_capacity"
	| "sandbox_schedulable_capacity"
	| "model_capacity"
	| "cluster_pressure"
	| "psi_memory_pressure"
	| "psi_io_pressure"
	| "psi_cpu_pressure"
	| "disk_pressure";

export type BenchmarkRuntimeCapacitySnapshot = {
	capacityMode: "manual" | "auto" | "kueue";
	requestedConcurrency: number;
	deterministicConcurrency: number;
	pressureAdjustedConcurrency: number;
	effectiveConcurrency: number;
	runtimeClass: string;
	runtimeAppId: string;
	runtimeReplicas: number;
	perSidecarWorkflowLimit: number;
	daprWorkflowLimitPerSidecar: number;
	daprWorkflowEffectiveCapacity: number;
	parentWorkflowRuntime: ParentWorkflowRuntimeSnapshot | null;
	agentHostRuntime: AgentHostDaprRuntimeSnapshot | null;
	parentWorkflowReplicas: number | null;
	parentWorkflowReadyReplicas: number | null;
	parentWorkflowConnectedWorkers: number | null;
	parentWorkflowConnectedWorkerPods: number | null;
	parentWorkflowLimitPerSidecar: number | null;
	parentActivityLimitPerSidecar: number | null;
	parentConfigurationWorkflowLimitPerSidecar: number | null;
	parentConfigurationActivityLimitPerSidecar: number | null;
	parentWorkerWorkflowLimitPerSidecar: number | null;
	parentWorkerActivityLimitPerSidecar: number | null;
	parentWorkflowEffectiveCapacity: number | null;
	parentActivityEffectiveCapacity: number | null;
	agentHostActivePods: number | null;
	agentHostUnhealthyPods: string[];
	agentHostOomKilledPods: string[];
	agentHostRecentActorErrorCount: number | null;
	agentHostRecentReminderErrorCount: number | null;
	agentHostDaprRuntimePressure: boolean;
	daprRuntimeVersion: string | null;
	daprSchedulerPods: number | null;
	daprSchedulerReadyPods: number | null;
	daprRecentActorErrorCount: number | null;
	daprRecentReminderErrorCount: number | null;
	daprRecentStaleWorkflowEventCount: number | null;
	daprRecentStartPendingTimeoutCount: number | null;
	daprRuntimePressure: boolean;
	agentWorkflowMaxActiveTurns: number | null;
	runtimeSlots: number;
	slotsPerReplica: number;
	configuredMaxActiveInferenceInstances: number | null;
	maxActiveInferenceInstances: number | null;
	maxActiveSessions: number;
	configuredMaxActiveSandboxes: number | null;
	maxActiveSandboxes: number | null;
	schedulableSandboxCapacity: number | null;
	sandboxCapacity: BenchmarkSandboxCapacitySnapshot | null;
	clusterPressure: BenchmarkClusterPressureSnapshot | null;
	modelMaxActiveRequests: number | null;
	capacityLimiters: BenchmarkCapacityLimiter[];
	primaryLimiter: BenchmarkCapacityLimiter | null;
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
	clusterPressure?: BenchmarkClusterPressureSnapshot | null;
	parentWorkflowRuntime?: ParentWorkflowRuntimeSnapshot | null;
	agentHostRuntime?: AgentHostDaprRuntimeSnapshot | null;
	modelMaxActiveRequests?: number | null;
	modelNameOrPath?: string | null;
	modelConfigLabel?: string | null;
	agentSlug?: string | null;
	executionBackend?: string | null;
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

function normalizedModelKey(value: string | null | undefined): string | null {
	if (!value?.trim()) return null;
	return value.trim().toLowerCase();
}

function configuredModelMaxActiveRequests(input: BenchmarkRuntimeCapacityInput) {
	const raw = process.env.BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS_JSON;
	const keys = [input.modelNameOrPath, input.modelConfigLabel, input.agentSlug]
		.map(normalizedModelKey)
		.filter((entry): entry is string => !!entry);
	if (raw?.trim() && keys.length > 0) {
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const record = Object.fromEntries(
					Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
						key.toLowerCase(),
						value,
					]),
				);
				for (const key of keys) {
					const value = positiveInt(record[key]);
					if (value) return value;
				}
			}
		} catch {
			// Ignore invalid optional capacity config; global caps still apply.
		}
	}
	return (
		positiveInt(input.modelMaxActiveRequests) ??
		positiveInt(process.env.BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS) ??
		positiveInt(process.env.BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS)
	);
}

function isKueueExecutionBackend(value: unknown): boolean {
	if (typeof value !== "string" || !value.trim()) return false;
	const normalized = value.trim().toLowerCase().replace(/_/g, "-");
	return (
		normalized === "dapr-kueue" ||
		normalized === "kueue-dapr" ||
		normalized === "kueue-agent-hosts" ||
		normalized === "agent-host-kueue" ||
		normalized === "host" ||
		normalized === "host-execution" ||
		normalized === "host-execution-plane"
	);
}

function capacityMode(input: BenchmarkRuntimeCapacityInput): "manual" | "auto" | "kueue" {
	if (isKueueExecutionBackend(input.executionBackend)) return "kueue";
	const normalized = (process.env.BENCHMARK_CAPACITY_MODE ?? "").trim().toLowerCase();
	return normalized === "auto" || normalized === "dynamic" ? "auto" : "manual";
}

function finiteMin(values: Array<number | null | undefined>): number | null {
	const candidates = values.filter(
		(value): value is number => typeof value === "number" && Number.isFinite(value),
	);
	return candidates.length > 0 ? Math.min(...candidates) : null;
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
			positiveInt(input.poolMaxReplicas) ?? envPositiveInt("AGENT_RUNTIME_POOL_MAX_REPLICAS", 2)
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
		positiveInt(input.slotsPerReplica) ?? slotsByRuntimeClass()[runtimeClass] ?? 1;
	const daprWorkflowLimitPerSidecar =
		configuredDaprWorkflowLimitPerSidecar(runtimeClass) ?? slotsPerReplica;
	const runtimeSlots = Math.max(1, replicas * slotsPerReplica);
	const daprWorkflowEffectiveCapacity = Math.max(1, replicas * daprWorkflowLimitPerSidecar);
	const parentWorkflowRuntime = input.parentWorkflowRuntime ?? null;
	const agentHostRuntime = input.agentHostRuntime ?? null;
	const parentWorkflowEffectiveCapacity = positiveInt(
		parentWorkflowRuntime?.effectiveWorkflowCapacity,
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
	const mode = capacityMode(input);
	const configuredGlobalMax = positiveInt(process.env.BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES);
	const sandboxMax = positiveInt(process.env.BENCHMARK_MAX_ACTIVE_SANDBOXES);
	const schedulableSandboxCapacity = nonNegativeInt(
		input.schedulableSandboxCapacity ??
			(input.sandboxCapacity?.error
				? undefined
				: input.sandboxCapacity?.schedulableSandboxCapacity),
	);
	const schedulableKueueInstanceCapacity = nonNegativeInt(
		input.sandboxCapacity?.error
			? undefined
			: input.sandboxCapacity?.schedulableKueueInstanceCapacity,
	);
	const usingKueueInstanceCapacity = mode === "kueue" && schedulableKueueInstanceCapacity != null;
	const schedulableCapacityForRun =
		mode === "kueue"
			? (schedulableKueueInstanceCapacity ?? schedulableSandboxCapacity)
			: schedulableSandboxCapacity;
	const totalSchedulableSandboxCapacity = nonNegativeInt(
		input.sandboxCapacity?.error
			? undefined
			: input.sandboxCapacity?.totalSchedulableSandboxCapacity,
	);
	const sandboxRunHeadroomLimit =
		sandboxMax == null && schedulableCapacityForRun == null
			? null
			: Math.min(
					sandboxMax ?? Number.POSITIVE_INFINITY,
					schedulableCapacityForRun ?? Number.POSITIVE_INFINITY,
				);
	const sandboxActiveLimit =
		sandboxMax == null &&
		totalSchedulableSandboxCapacity == null &&
		schedulableSandboxCapacity == null
			? null
			: Math.min(
					sandboxMax ?? Number.POSITIVE_INFINITY,
					totalSchedulableSandboxCapacity ?? schedulableSandboxCapacity ?? Number.POSITIVE_INFINITY,
				);
	const modelMax = configuredModelMaxActiveRequests(input);
	const derivedActiveInferenceLimit = finiteMin([
		configuredGlobalMax,
		runtimeMax,
		agentWorkflowMaxActiveTurns,
		sandboxActiveLimit,
		modelMax,
	]);
	const globalMax =
		mode === "kueue"
			? Number.POSITIVE_INFINITY
			: mode === "auto"
				? (configuredGlobalMax ?? derivedActiveInferenceLimit ?? runtimeMax)
				: (configuredGlobalMax ?? DEFAULT_MAX_ACTIVE_INFERENCE_INSTANCES);
	const deterministic = Math.min(
		requested,
		selectedCount,
		mode === "kueue" ? Number.POSITIVE_INFINITY : runtimeMax,
		parentWorkflowEffectiveCapacity ?? Number.POSITIVE_INFINITY,
		globalMax,
		agentWorkflowMaxActiveTurns ?? Number.POSITIVE_INFINITY,
		mode === "kueue"
			? (sandboxRunHeadroomLimit ?? Number.POSITIVE_INFINITY)
			: (sandboxRunHeadroomLimit ?? Number.POSITIVE_INFINITY),
		modelMax ?? Number.POSITIVE_INFINITY,
	);
	const pressureReasons: BenchmarkCapacityLimiter[] = [];
	const clusterPressure = input.clusterPressure ?? null;
	if (clusterPressure?.pressure) {
		for (const reason of clusterPressure.reasons) {
			if (!pressureReasons.includes(reason)) pressureReasons.push(reason);
		}
	}
	if (input.sandboxCapacity?.diskPressureNodeCount) {
		if (!pressureReasons.includes("disk_pressure")) {
			pressureReasons.push("disk_pressure");
		}
	}
	if (parentWorkflowRuntime?.daprRuntimePressure) {
		pressureReasons.push("dapr_runtime_pressure");
	}
	if (agentHostRuntime?.daprRuntimePressure) {
		pressureReasons.push("agent_host_pressure");
	}
	if (input.sandboxCapacity?.kueueClusterQueueActive === false) {
		pressureReasons.push("kueue_capacity");
	}
	const hardPressure =
		clusterPressure?.hardBlock === true ||
		parentWorkflowRuntime?.daprRuntimePressure === true ||
		agentHostRuntime?.daprRuntimePressure === true ||
		(input.sandboxCapacity?.diskPressureNodeCount ?? 0) > 0 ||
		input.sandboxCapacity?.kueueClusterQueueActive === false;
	const pressureFactor = clusterPressure?.reductionFactor ?? 1;
	const pressureAdjusted = hardPressure
		? 0
		: Math.max(1, Math.floor(deterministic * pressureFactor));
	const effective = Math.min(deterministic, pressureAdjusted);
	const reasons: BenchmarkCapacityLimiter[] = [];
	if (requested > selectedCount && deterministic === selectedCount) {
		reasons.push("selected_instance_count");
	}
	if (requested > runtimeMax && deterministic === runtimeMax) {
		reasons.push("runtime_capacity");
	}
	if (
		parentWorkflowEffectiveCapacity != null &&
		requested > parentWorkflowEffectiveCapacity &&
		deterministic === parentWorkflowEffectiveCapacity
	) {
		reasons.push("dapr_parent_capacity");
	}
	if (
		requested > daprWorkflowEffectiveCapacity &&
		deterministic === daprWorkflowEffectiveCapacity
	) {
		reasons.push("dapr_workflow_capacity");
	}
	if (
		mode !== "kueue" &&
		(mode === "manual" || configuredGlobalMax != null) &&
		requested > globalMax &&
		deterministic === globalMax
	) {
		reasons.push("global_max");
	}
	if (
		agentWorkflowMaxActiveTurns &&
		requested > agentWorkflowMaxActiveTurns &&
		deterministic === agentWorkflowMaxActiveTurns
	) {
		reasons.push("agent_workflow_capacity");
	}
	if (sandboxMax && requested > sandboxMax && deterministic === sandboxMax) {
		reasons.push("sandbox_capacity");
	}
	if (
		schedulableCapacityForRun != null &&
		requested > schedulableCapacityForRun &&
		deterministic === schedulableCapacityForRun
	) {
		reasons.push(usingKueueInstanceCapacity ? "kueue_capacity" : "sandbox_schedulable_capacity");
	}
	if (modelMax && requested > modelMax && deterministic === modelMax) {
		reasons.push("model_capacity");
	}
	for (const reason of pressureReasons) {
		if (!reasons.includes(reason)) reasons.push(reason);
	}

	return {
		capacityMode: mode,
		requestedConcurrency: requested,
		deterministicConcurrency: deterministic,
		pressureAdjustedConcurrency: pressureAdjusted,
		effectiveConcurrency: effective,
		runtimeClass,
		runtimeAppId,
		runtimeReplicas: replicas,
		perSidecarWorkflowLimit: daprWorkflowLimitPerSidecar,
		daprWorkflowLimitPerSidecar,
		daprWorkflowEffectiveCapacity,
		parentWorkflowRuntime,
		agentHostRuntime,
		parentWorkflowReplicas: positiveInt(parentWorkflowRuntime?.replicas),
		parentWorkflowReadyReplicas: nonNegativeInt(parentWorkflowRuntime?.readyReplicas),
		parentWorkflowConnectedWorkers: nonNegativeInt(parentWorkflowRuntime?.connectedWorkflowWorkers),
		parentWorkflowConnectedWorkerPods: nonNegativeInt(parentWorkflowRuntime?.connectedWorkerPods),
		parentWorkflowLimitPerSidecar: positiveInt(parentWorkflowRuntime?.workflowLimitPerSidecar),
		parentActivityLimitPerSidecar: positiveInt(parentWorkflowRuntime?.activityLimitPerSidecar),
		parentConfigurationWorkflowLimitPerSidecar: positiveInt(
			parentWorkflowRuntime?.configurationWorkflowLimitPerSidecar,
		),
		parentConfigurationActivityLimitPerSidecar: positiveInt(
			parentWorkflowRuntime?.configurationActivityLimitPerSidecar,
		),
		parentWorkerWorkflowLimitPerSidecar: positiveInt(
			parentWorkflowRuntime?.workerWorkflowLimitPerSidecar,
		),
		parentWorkerActivityLimitPerSidecar: positiveInt(
			parentWorkflowRuntime?.workerActivityLimitPerSidecar,
		),
		parentWorkflowEffectiveCapacity,
		parentActivityEffectiveCapacity: positiveInt(parentWorkflowRuntime?.effectiveActivityCapacity),
		agentHostActivePods: nonNegativeInt(agentHostRuntime?.activePods),
		agentHostUnhealthyPods: agentHostRuntime?.unhealthyPods ?? [],
		agentHostOomKilledPods: agentHostRuntime?.appContainerOomKilledPods ?? [],
		agentHostRecentActorErrorCount: nonNegativeInt(agentHostRuntime?.recentActorErrorCount),
		agentHostRecentReminderErrorCount: nonNegativeInt(agentHostRuntime?.recentReminderErrorCount),
		agentHostDaprRuntimePressure: agentHostRuntime?.daprRuntimePressure === true,
		daprRuntimeVersion: parentWorkflowRuntime?.daprRuntimeVersion ?? null,
		daprSchedulerPods: nonNegativeInt(parentWorkflowRuntime?.schedulerPods),
		daprSchedulerReadyPods: nonNegativeInt(parentWorkflowRuntime?.schedulerReadyPods),
		daprRecentActorErrorCount: nonNegativeInt(parentWorkflowRuntime?.recentActorErrorCount),
		daprRecentReminderErrorCount: nonNegativeInt(parentWorkflowRuntime?.recentReminderErrorCount),
		daprRecentStaleWorkflowEventCount: nonNegativeInt(
			parentWorkflowRuntime?.recentStaleWorkflowEventCount,
		),
		daprRecentStartPendingTimeoutCount: nonNegativeInt(
			parentWorkflowRuntime?.recentStartPendingTimeoutCount,
		),
		daprRuntimePressure: parentWorkflowRuntime?.daprRuntimePressure === true,
		agentWorkflowMaxActiveTurns,
		runtimeSlots,
		slotsPerReplica,
		configuredMaxActiveInferenceInstances: configuredGlobalMax,
		maxActiveInferenceInstances:
			mode === "kueue"
				? null
				: mode === "auto"
					? derivedActiveInferenceLimit
					: (configuredGlobalMax ?? DEFAULT_MAX_ACTIVE_INFERENCE_INSTANCES),
		maxActiveSessions: Math.min(
			mode === "kueue" ? selectedCount : runtimeMax,
			globalMax,
			agentWorkflowMaxActiveTurns ?? Number.POSITIVE_INFINITY,
			mode === "kueue"
				? (sandboxRunHeadroomLimit ?? Number.POSITIVE_INFINITY)
				: Number.POSITIVE_INFINITY,
			modelMax ?? Number.POSITIVE_INFINITY,
		),
		configuredMaxActiveSandboxes: sandboxMax,
		maxActiveSandboxes: sandboxActiveLimit,
		schedulableSandboxCapacity,
		sandboxCapacity: input.sandboxCapacity ?? null,
		clusterPressure,
		modelMaxActiveRequests: modelMax,
		capacityLimiters: reasons,
		primaryLimiter: reasons[0] ?? null,
		capReason: reasons.length > 0 ? reasons.join("+") : null,
	};
}
