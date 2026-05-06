import { error } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { benchmarkRuns, type BenchmarkResourceLeaseType } from "$lib/server/db/schema";
import { resolveAgentRuntimeRoute } from "$lib/server/agents/runtime-routing";
import { estimateBenchmarkRuntimeCapacity } from "./runtime-capacity";
import { loadSchedulableSandboxCapacitySnapshot } from "./sandbox-capacity";
import { loadBenchmarkResourceCapacityDiagnostics } from "./resource-leases";
import { resolveBenchmarkAgent } from "./service";

const DIAGNOSTIC_RESOURCES = [
	"inference_slot",
	"openshell_sandbox",
	"agent_runtime_slot",
	"dapr_workflow_slot",
	"model_slot",
	"evaluator_slot",
] satisfies BenchmarkResourceLeaseType[];

function requireDb() {
	if (!db) throw error(503, "Database not configured");
	return db;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function capacityFromSummary(summary: unknown): Record<string, unknown> {
	const capacity = isRecord(summary) ? summary.capacity : null;
	return isRecord(capacity) ? capacity : {};
}

function instanceCount(value: unknown): number {
	if (Array.isArray(value)) return Math.max(1, value.length);
	return Math.max(1, positiveInt(value) ?? 1);
}

export type BenchmarkCapacityDiagnostics = {
	requestedConcurrency: number;
	storedEffectiveConcurrency: number;
	selectedInstanceCount: number;
	blockedBy: BenchmarkResourceLeaseType[];
	resources: Awaited<ReturnType<typeof loadBenchmarkResourceCapacityDiagnostics>>;
	runtime: {
		class: string | null;
		appId: string | null;
		replicas: number | null;
		slotsPerReplica: number | null;
		slots: number | null;
		maxActiveSessions: number | null;
	};
	daprWorkflow: {
		perSidecarLimit: number | null;
		effectiveCapacity: number | null;
		agentWorkflowMaxActiveTurns: number | null;
	};
	sandbox: {
		configuredMaxActiveSandboxes: number | null;
		maxActiveSandboxes: number | null;
		schedulableSandboxCapacity: number | null;
		availableSandboxSlots: number | null;
		activeSwebenchPods: number | null;
		pendingSwebenchPods: number | null;
		error?: string | null;
	};
	modelCaps: {
		modelMaxActiveRequests: number | null;
	};
	capReason: string | null;
	computedAt: string;
};

function diagnosticsFromCapacity(params: {
	run: typeof benchmarkRuns.$inferSelect;
	capacity: Record<string, unknown>;
	selectedInstanceCount: number;
	resources: Awaited<ReturnType<typeof loadBenchmarkResourceCapacityDiagnostics>>;
}): BenchmarkCapacityDiagnostics {
	const capacity = params.capacity;
	const sandboxCapacity = isRecord(capacity.sandboxCapacity)
		? capacity.sandboxCapacity
		: {};
	const blockedBy = params.resources
		.filter((resource) => resource.blocked)
		.map((resource) => resource.resourceType);

	return {
		requestedConcurrency:
			positiveInt(capacity.requestedConcurrency) ??
			positiveInt(params.run.concurrency) ??
			1,
		storedEffectiveConcurrency:
			nonNegativeInt(capacity.effectiveConcurrency) ??
			nonNegativeInt(params.run.concurrency) ??
			1,
		selectedInstanceCount: params.selectedInstanceCount,
		blockedBy,
		resources: params.resources,
		runtime: {
			class: typeof capacity.runtimeClass === "string" ? capacity.runtimeClass : null,
			appId: typeof capacity.runtimeAppId === "string" ? capacity.runtimeAppId : null,
			replicas: positiveInt(capacity.runtimeReplicas),
			slotsPerReplica: positiveInt(capacity.slotsPerReplica),
			slots: positiveInt(capacity.runtimeSlots),
			maxActiveSessions: positiveInt(capacity.maxActiveSessions),
		},
		daprWorkflow: {
			perSidecarLimit:
				positiveInt(capacity.daprWorkflowLimitPerSidecar) ??
				positiveInt(capacity.perSidecarWorkflowLimit),
			effectiveCapacity: positiveInt(capacity.daprWorkflowEffectiveCapacity),
			agentWorkflowMaxActiveTurns: positiveInt(capacity.agentWorkflowMaxActiveTurns),
		},
		sandbox: {
			configuredMaxActiveSandboxes: nonNegativeInt(capacity.configuredMaxActiveSandboxes),
			maxActiveSandboxes: nonNegativeInt(capacity.maxActiveSandboxes),
			schedulableSandboxCapacity: nonNegativeInt(capacity.schedulableSandboxCapacity),
			availableSandboxSlots: nonNegativeInt(sandboxCapacity.availableSandboxSlots),
			activeSwebenchPods: nonNegativeInt(sandboxCapacity.activeSwebenchPods),
			pendingSwebenchPods: nonNegativeInt(sandboxCapacity.pendingSwebenchPods),
			error:
				typeof sandboxCapacity.error === "string"
					? sandboxCapacity.error
					: null,
		},
		modelCaps: {
			modelMaxActiveRequests: positiveInt(capacity.modelMaxActiveRequests),
		},
		capReason: typeof capacity.capReason === "string" ? capacity.capReason : null,
		computedAt: new Date().toISOString(),
	};
}

export const __benchmarkCapacityDiagnosticsForTest = {
	diagnosticsFromCapacity,
	instanceCount,
};

export async function getBenchmarkRunCapacityDiagnostics(
	projectId: string,
	runId: string,
): Promise<BenchmarkCapacityDiagnostics | null> {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(benchmarkRuns)
		.where(and(eq(benchmarkRuns.projectId, projectId), eq(benchmarkRuns.id, runId)))
		.limit(1);
	if (!run) return null;
	const capacity = capacityFromSummary(run.summary);
	const selectedInstanceCount = instanceCount(run.selectedInstanceIds);
	const liveSandboxCapacity = await loadSchedulableSandboxCapacitySnapshot();
	const resources = await loadBenchmarkResourceCapacityDiagnostics({
		run,
		resources: DIAGNOSTIC_RESOURCES,
		liveSandboxCapacity,
	});
	return diagnosticsFromCapacity({
		run,
		capacity,
		selectedInstanceCount,
		resources,
	});
}

export async function getBenchmarkLaunchCapacityDiagnostics(input: {
	projectId: string;
	agentId: string;
	agentVersion?: number;
	instanceIds?: unknown;
	instanceCount?: unknown;
	requestedConcurrency?: unknown;
	evaluationConcurrency?: unknown;
	modelNameOrPath?: string | null;
	modelConfigLabel?: string | null;
}): Promise<BenchmarkCapacityDiagnostics> {
	const selectedInstanceCount = input.instanceIds
		? instanceCount(input.instanceIds)
		: instanceCount(input.instanceCount);
	const agent = await resolveBenchmarkAgent({
		projectId: input.projectId,
		agentId: input.agentId,
		version: input.agentVersion,
		requestedModelNameOrPath:
			input.modelNameOrPath ?? input.modelConfigLabel ?? null,
	});
	const runtimeRoute = resolveAgentRuntimeRoute({
		agentSlug: agent.slug,
		runtimeAppId: agent.runtimeAppId,
		config: agent.config,
	});
	const sandboxCapacity = await loadSchedulableSandboxCapacitySnapshot();
	const capacity = estimateBenchmarkRuntimeCapacity({
		runtimeClass: runtimeRoute.runtimeClass,
		runtimeIsolation: runtimeRoute.isolation,
		runtimeAppId: runtimeRoute.appId,
		poolMaxReplicas: runtimeRoute.pool?.maxReplicas,
		slotsPerReplica: runtimeRoute.pool?.slotsPerReplica,
		maxActiveSessions: runtimeRoute.pool?.maxActiveSessions,
		sandboxCapacity,
		requestedInstanceCount: selectedInstanceCount,
		requestedConcurrency: input.requestedConcurrency,
	});
	const pseudoRun = {
		id: "launch-candidate",
		projectId: input.projectId,
		userId: "",
		suiteId: "",
		agentId: agent.id,
		agentVersion: agent.version,
		agentRuntime: agent.runtime,
		agentRuntimeAppId: runtimeRoute.appId,
		status: "queued",
		modelNameOrPath:
			input.modelNameOrPath?.trim() ||
			input.modelConfigLabel?.trim() ||
			agent.modelSpec ||
			`${agent.slug}@v${agent.version}`,
		modelConfigLabel: input.modelConfigLabel?.trim() || null,
		selectedInstanceIds: Array.from({ length: selectedInstanceCount }, (_, index) =>
			String(index),
		),
		concurrency: capacity.effectiveConcurrency,
		evaluationConcurrency: positiveInt(input.evaluationConcurrency) ?? 24,
		timeoutSeconds: 7200,
		maxTurns: null,
		evaluatorResourceClass: "standard",
		coordinatorExecutionId: null,
		evaluatorJobName: null,
		predictionsPath: null,
		mlflowExperimentId: null,
		mlflowRunId: null,
		summary: { capacity },
		tags: [],
		error: null,
		cancelRequestedAt: null,
		startedAt: null,
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as typeof benchmarkRuns.$inferSelect;
	const resources = await loadBenchmarkResourceCapacityDiagnostics({
		run: pseudoRun,
		resources: DIAGNOSTIC_RESOURCES,
		liveSandboxCapacity: sandboxCapacity,
	});
	return diagnosticsFromCapacity({
		run: pseudoRun,
		capacity,
		selectedInstanceCount,
		resources,
	});
}
