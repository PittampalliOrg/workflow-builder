import { error } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	benchmarkRuns,
	type BenchmarkResourceLeaseType,
} from "$lib/server/db/schema";
import { resolveAgentRuntimeRoute } from "$lib/server/agents/runtime-routing";
import {
	listDaprComponents,
	type DaprComponent,
} from "$lib/server/kube/client";
import {
	fetchCapacityObserverSnapshot,
	summarizeCapacityObserverForQueue,
} from "$lib/server/capacity/observer";
import { buildCapacityCoverageSummary } from "$lib/server/capacity/coverage";
import type { CapacityObserverResult } from "$lib/types/capacity";
import { estimateBenchmarkRuntimeCapacity } from "./runtime-capacity";
import { loadParentWorkflowRuntimeSnapshot } from "./dapr-workflow-capacity";
import { loadSchedulableSandboxCapacitySnapshot } from "./sandbox-capacity";
import { loadBenchmarkResourceCapacityDiagnostics } from "./resource-leases";
import { resolveBenchmarkAgent } from "./service";
import {
	summarizeBenchmarkClusterPressure,
	type BenchmarkClusterPressureSnapshot,
} from "./cluster-pressure";

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
	deterministicConcurrency: number;
	pressureAdjustedConcurrency: number;
	storedEffectiveConcurrency: number;
	selectedInstanceCount: number;
	blockedBy: BenchmarkResourceLeaseType[];
	resources: Awaited<
		ReturnType<typeof loadBenchmarkResourceCapacityDiagnostics>
	>;
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
	parentWorkflow: {
		appId: string | null;
		replicas: number | null;
		readyReplicas: number | null;
		connectedWorkers: number | null;
		connectedWorkerPods: number | null;
		podWorkers: unknown[];
		workflowLimitPerSidecar: number | null;
		activityLimitPerSidecar: number | null;
		effectiveWorkflowCapacity: number | null;
		effectiveActivityCapacity: number | null;
		daprRuntimeVersion: string | null;
		schedulerPods: number | null;
		schedulerReadyPods: number | null;
		recentActorErrorCount: number | null;
		recentReminderErrorCount: number | null;
		daprRuntimePressure: boolean;
		error: string | null;
	};
	sandbox: {
		configuredMaxActiveSandboxes: number | null;
		maxActiveSandboxes: number | null;
		schedulableSandboxCapacity: number | null;
		availableSandboxSlots: number | null;
		activeSwebenchPods: number | null;
		pendingSwebenchPods: number | null;
		ephemeralStorageLimitedCapacity: number | null;
		nodeFsLimitedCapacity: number | null;
		nodeFsAvailableBytes: number | null;
		nodeFsEvictionReserveBytes: number | null;
		kueueClusterQueueName: string | null;
		kueueClusterQueueActive: boolean | null;
		kueueClusterQueueReason: string | null;
		kueueClusterQueueMessage: string | null;
		kueueAvailableSandboxSlots: number | null;
		kueueBorrowAvailableSandboxSlots: number | null;
		kueueCpuLimitedCapacity: number | null;
		kueueMemoryLimitedCapacity: number | null;
		kueueEphemeralStorageLimitedCapacity: number | null;
		kueuePodLimitedCapacity: number | null;
		kueueInstanceRequestCpuMilli: number | null;
		kueueInstanceRequestMemoryBytes: number | null;
		kueueInstanceRequestEphemeralStorageBytes: number | null;
		kueueInstancePodCount: number | null;
		kueueAvailableInstanceSlots: number | null;
		kueueBorrowAvailableInstanceSlots: number | null;
		kueueInstanceCpuLimitedCapacity: number | null;
		kueueInstanceMemoryLimitedCapacity: number | null;
		kueueInstanceEphemeralStorageLimitedCapacity: number | null;
		kueueInstancePodLimitedCapacity: number | null;
		schedulableKueueInstanceCapacity: number | null;
		diskPressureNodeCount: number | null;
		error?: string | null;
	};
	modelCaps: {
		modelMaxActiveRequests: number | null;
	};
	clusterPressure: BenchmarkClusterPressureSnapshot | null;
	sharedCapacity: ReturnType<typeof summarizeCapacityObserverForQueue>;
	coverage: ReturnType<typeof buildCapacityCoverageSummary>;
	workflowLifecycle: BenchmarkWorkflowLifecycleDiagnostics;
	capReason: string | null;
	computedAt: string;
};

export type BenchmarkWorkflowActorStateStore = {
	componentName: string;
	componentType: string | null;
	tablePrefix: string | null;
	connectionSecretRef: string | null;
	scoped: boolean;
};

export type BenchmarkWorkflowLifecycleDiagnostics = {
	parentAppId: string;
	childAppId: string | null;
	sharedActorStateStore: boolean | null;
	parentActorStateStore: BenchmarkWorkflowActorStateStore | null;
	childActorStateStore: BenchmarkWorkflowActorStateStore | null;
	issue: string | null;
	error: string | null;
};

const PARENT_WORKFLOW_APP_ID = "workflow-orchestrator";

type DaprComponentMetadata = NonNullable<
	NonNullable<DaprComponent["spec"]>["metadata"]
>[number];

function componentMetadata(
	component: DaprComponent,
	name: string,
): DaprComponentMetadata | undefined {
	return component.spec?.metadata?.find((entry) => entry.name === name);
}

function metadataValue(component: DaprComponent, name: string): string | null {
	const entry = componentMetadata(component, name);
	if (!entry) return null;
	if (typeof entry.value === "string" && entry.value.trim())
		return entry.value.trim();
	if (typeof entry.value === "number" || typeof entry.value === "boolean") {
		return String(entry.value);
	}
	return null;
}

function metadataSecretRef(
	component: DaprComponent,
	name: string,
): string | null {
	const entry = componentMetadata(component, name);
	const secret = entry?.secretKeyRef;
	if (!secret?.name || !secret.key) return null;
	return `${secret.name}:${secret.key}`;
}

function isActorStateStore(component: DaprComponent): boolean {
	return metadataValue(component, "actorStateStore")?.toLowerCase() === "true";
}

function componentVisibleToApp(
	component: DaprComponent,
	appId: string,
): boolean {
	const scopes = component.scopes ?? [];
	return scopes.length === 0 || scopes.includes(appId);
}

function actorStoreForApp(
	components: DaprComponent[],
	appId: string,
): BenchmarkWorkflowActorStateStore | null {
	const stores = components.filter(
		(component) =>
			isActorStateStore(component) && componentVisibleToApp(component, appId),
	);
	if (stores.length !== 1) return null;
	const [store] = stores;
	return {
		componentName: store.metadata?.name ?? "unknown",
		componentType: store.spec?.type ?? null,
		tablePrefix: metadataValue(store, "tablePrefix"),
		connectionSecretRef: metadataSecretRef(store, "connectionString"),
		scoped: (store.scopes ?? []).length > 0,
	};
}

function actorStoreCountForApp(
	components: DaprComponent[],
	appId: string,
): number {
	return components.filter(
		(component) =>
			isActorStateStore(component) && componentVisibleToApp(component, appId),
	).length;
}

function actorStoreIdentity(store: BenchmarkWorkflowActorStateStore): string {
	return [
		store.componentType ?? "",
		store.connectionSecretRef ?? "",
		store.tablePrefix ?? "",
	].join("|");
}

export function buildWorkflowLifecycleDiagnostics(params: {
	components: DaprComponent[];
	childAppId?: string | null;
	parentAppId?: string | null;
	error?: string | null;
}): BenchmarkWorkflowLifecycleDiagnostics {
	const parentAppId = params.parentAppId ?? PARENT_WORKFLOW_APP_ID;
	const childAppId = params.childAppId?.trim() || null;
	if (params.error) {
		return {
			parentAppId,
			childAppId,
			sharedActorStateStore: null,
			parentActorStateStore: null,
			childActorStateStore: null,
			issue: "dapr_component_diagnostics_unavailable",
			error: params.error,
		};
	}
	if (!childAppId) {
		return {
			parentAppId,
			childAppId,
			sharedActorStateStore: null,
			parentActorStateStore: null,
			childActorStateStore: null,
			issue: "missing_child_app_id",
			error: null,
		};
	}

	const parentCount = actorStoreCountForApp(params.components, parentAppId);
	const childCount = actorStoreCountForApp(params.components, childAppId);
	const parentStore = actorStoreForApp(params.components, parentAppId);
	const childStore = actorStoreForApp(params.components, childAppId);
	const issue =
		parentCount === 0
			? "missing_parent_actor_state_store"
			: parentCount > 1
				? "duplicate_parent_actor_state_store"
				: childCount === 0
					? "missing_child_actor_state_store"
					: childCount > 1
						? "duplicate_child_actor_state_store"
						: parentStore &&
							  childStore &&
							  actorStoreIdentity(parentStore) !==
									actorStoreIdentity(childStore)
							? "dapr_actor_state_store_mismatch"
							: null;

	return {
		parentAppId,
		childAppId,
		sharedActorStateStore:
			parentStore && childStore
				? actorStoreIdentity(parentStore) === actorStoreIdentity(childStore)
				: null,
		parentActorStateStore: parentStore,
		childActorStateStore: childStore,
		issue,
		error: null,
	};
}

async function loadWorkflowLifecycleDiagnostics(
	childAppId: string | null | undefined,
): Promise<BenchmarkWorkflowLifecycleDiagnostics> {
	try {
		const components = await listDaprComponents();
		return buildWorkflowLifecycleDiagnostics({ components, childAppId });
	} catch (err) {
		return buildWorkflowLifecycleDiagnostics({
			components: [],
			childAppId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function diagnosticsFromCapacity(params: {
	run: typeof benchmarkRuns.$inferSelect;
	capacity: Record<string, unknown>;
	selectedInstanceCount: number;
	resources: Awaited<
		ReturnType<typeof loadBenchmarkResourceCapacityDiagnostics>
	>;
	workflowLifecycle?: BenchmarkWorkflowLifecycleDiagnostics | null;
	sharedCapacity?: CapacityObserverResult | null;
}): BenchmarkCapacityDiagnostics {
	const capacity = params.capacity;
	const sandboxCapacity = isRecord(capacity.sandboxCapacity)
		? capacity.sandboxCapacity
		: {};
	const clusterPressure = isRecord(capacity.clusterPressure)
		? (capacity.clusterPressure as BenchmarkClusterPressureSnapshot)
		: null;
	const parentRuntime = isRecord(capacity.parentWorkflowRuntime)
		? capacity.parentWorkflowRuntime
		: {};
	const blockedBy = params.resources
		.filter((resource) => resource.blocked)
		.map((resource) => resource.resourceType);

	return {
		requestedConcurrency:
			positiveInt(capacity.requestedConcurrency) ??
			positiveInt(params.run.concurrency) ??
			1,
		deterministicConcurrency:
			nonNegativeInt(capacity.deterministicConcurrency) ??
			nonNegativeInt(capacity.effectiveConcurrency) ??
			nonNegativeInt(params.run.concurrency) ??
			1,
		pressureAdjustedConcurrency:
			nonNegativeInt(capacity.pressureAdjustedConcurrency) ??
			nonNegativeInt(capacity.effectiveConcurrency) ??
			nonNegativeInt(params.run.concurrency) ??
			1,
		storedEffectiveConcurrency:
			nonNegativeInt(capacity.effectiveConcurrency) ??
			nonNegativeInt(params.run.concurrency) ??
			1,
		selectedInstanceCount: params.selectedInstanceCount,
		blockedBy,
		resources: params.resources,
		runtime: {
			class:
				typeof capacity.runtimeClass === "string"
					? capacity.runtimeClass
					: null,
			appId:
				typeof capacity.runtimeAppId === "string"
					? capacity.runtimeAppId
					: null,
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
			agentWorkflowMaxActiveTurns: positiveInt(
				capacity.agentWorkflowMaxActiveTurns,
			),
		},
		parentWorkflow: {
			appId:
				typeof parentRuntime.parentAppId === "string"
					? parentRuntime.parentAppId
					: "workflow-orchestrator",
			replicas: positiveInt(capacity.parentWorkflowReplicas),
			readyReplicas: nonNegativeInt(capacity.parentWorkflowReadyReplicas),
			connectedWorkers: nonNegativeInt(
				capacity.parentWorkflowConnectedWorkers,
			),
			connectedWorkerPods: nonNegativeInt(
				capacity.parentWorkflowConnectedWorkerPods,
			),
			podWorkers: Array.isArray(parentRuntime.podWorkers)
				? parentRuntime.podWorkers
				: [],
			workflowLimitPerSidecar: positiveInt(
				capacity.parentWorkflowLimitPerSidecar,
			),
			activityLimitPerSidecar: positiveInt(
				capacity.parentActivityLimitPerSidecar,
			),
			effectiveWorkflowCapacity: positiveInt(
				capacity.parentWorkflowEffectiveCapacity,
			),
			effectiveActivityCapacity: positiveInt(
				capacity.parentActivityEffectiveCapacity,
			),
			daprRuntimeVersion:
				typeof capacity.daprRuntimeVersion === "string"
					? capacity.daprRuntimeVersion
					: null,
			schedulerPods: nonNegativeInt(capacity.daprSchedulerPods),
			schedulerReadyPods: nonNegativeInt(capacity.daprSchedulerReadyPods),
			recentActorErrorCount: nonNegativeInt(
				capacity.daprRecentActorErrorCount,
			),
			recentReminderErrorCount: nonNegativeInt(
				capacity.daprRecentReminderErrorCount,
			),
			daprRuntimePressure: capacity.daprRuntimePressure === true,
			error:
				typeof parentRuntime.error === "string" ? parentRuntime.error : null,
		},
		sandbox: {
			configuredMaxActiveSandboxes: nonNegativeInt(
				capacity.configuredMaxActiveSandboxes,
			),
			maxActiveSandboxes: nonNegativeInt(capacity.maxActiveSandboxes),
			schedulableSandboxCapacity: nonNegativeInt(
				capacity.schedulableSandboxCapacity,
			),
			availableSandboxSlots: nonNegativeInt(
				sandboxCapacity.availableSandboxSlots,
			),
			activeSwebenchPods: nonNegativeInt(sandboxCapacity.activeSwebenchPods),
			pendingSwebenchPods: nonNegativeInt(sandboxCapacity.pendingSwebenchPods),
			ephemeralStorageLimitedCapacity: nonNegativeInt(
				sandboxCapacity.ephemeralStorageLimitedCapacity,
			),
			nodeFsLimitedCapacity: nonNegativeInt(sandboxCapacity.nodeFsLimitedCapacity),
			nodeFsAvailableBytes: nonNegativeInt(sandboxCapacity.nodeFsAvailableBytes),
			nodeFsEvictionReserveBytes: nonNegativeInt(
				sandboxCapacity.nodeFsEvictionReserveBytes,
			),
			kueueClusterQueueName:
				typeof sandboxCapacity.kueueClusterQueueName === "string"
					? sandboxCapacity.kueueClusterQueueName
					: null,
			kueueClusterQueueActive:
				typeof sandboxCapacity.kueueClusterQueueActive === "boolean"
					? sandboxCapacity.kueueClusterQueueActive
					: null,
			kueueClusterQueueReason:
				typeof sandboxCapacity.kueueClusterQueueReason === "string"
					? sandboxCapacity.kueueClusterQueueReason
					: null,
			kueueClusterQueueMessage:
				typeof sandboxCapacity.kueueClusterQueueMessage === "string"
					? sandboxCapacity.kueueClusterQueueMessage
					: null,
			kueueAvailableSandboxSlots: nonNegativeInt(
				sandboxCapacity.kueueAvailableSandboxSlots,
			),
			kueueBorrowAvailableSandboxSlots: nonNegativeInt(
				sandboxCapacity.kueueBorrowAvailableSandboxSlots,
			),
			kueueCpuLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueueCpuLimitedCapacity,
			),
			kueueMemoryLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueueMemoryLimitedCapacity,
			),
			kueueEphemeralStorageLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueueEphemeralStorageLimitedCapacity,
			),
			kueuePodLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueuePodLimitedCapacity,
			),
			kueueInstanceRequestCpuMilli: nonNegativeInt(
				sandboxCapacity.kueueInstanceRequestCpuMilli,
			),
			kueueInstanceRequestMemoryBytes: nonNegativeInt(
				sandboxCapacity.kueueInstanceRequestMemoryBytes,
			),
			kueueInstanceRequestEphemeralStorageBytes: nonNegativeInt(
				sandboxCapacity.kueueInstanceRequestEphemeralStorageBytes,
			),
			kueueInstancePodCount: nonNegativeInt(
				sandboxCapacity.kueueInstancePodCount,
			),
			kueueAvailableInstanceSlots: nonNegativeInt(
				sandboxCapacity.kueueAvailableInstanceSlots,
			),
			kueueBorrowAvailableInstanceSlots: nonNegativeInt(
				sandboxCapacity.kueueBorrowAvailableInstanceSlots,
			),
			kueueInstanceCpuLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueueInstanceCpuLimitedCapacity,
			),
			kueueInstanceMemoryLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueueInstanceMemoryLimitedCapacity,
			),
			kueueInstanceEphemeralStorageLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueueInstanceEphemeralStorageLimitedCapacity,
			),
			kueueInstancePodLimitedCapacity: nonNegativeInt(
				sandboxCapacity.kueueInstancePodLimitedCapacity,
			),
			schedulableKueueInstanceCapacity: nonNegativeInt(
				sandboxCapacity.schedulableKueueInstanceCapacity,
			),
			diskPressureNodeCount: nonNegativeInt(
				sandboxCapacity.diskPressureNodeCount,
			),
			error:
				typeof sandboxCapacity.error === "string"
					? sandboxCapacity.error
					: null,
		},
		modelCaps: {
			modelMaxActiveRequests: positiveInt(capacity.modelMaxActiveRequests),
		},
		clusterPressure,
		sharedCapacity: summarizeCapacityObserverForQueue({
			result:
				params.sharedCapacity ?? {
					available: false,
					snapshot: null,
					error: "capacity_observer_not_queried",
				},
			queueName:
				typeof sandboxCapacity.kueueClusterQueueName === "string"
					? sandboxCapacity.kueueClusterQueueName
					: typeof capacity.runtimeClass === "string"
						? capacity.runtimeClass
						: null,
			executionClass:
				typeof capacity.runtimeClass === "string"
					? capacity.runtimeClass
					: typeof capacity.executionClass === "string"
						? capacity.executionClass
						: null,
		}),
		coverage: buildCapacityCoverageSummary(params.sharedCapacity),
		workflowLifecycle:
			params.workflowLifecycle ??
			buildWorkflowLifecycleDiagnostics({
				components: [],
				childAppId:
					typeof capacity.runtimeAppId === "string"
						? capacity.runtimeAppId
						: params.run.agentRuntimeAppId,
				error: "not_computed",
			}),
		capReason:
			typeof capacity.capReason === "string" ? capacity.capReason : null,
		computedAt: new Date().toISOString(),
	};
}

export const __benchmarkCapacityDiagnosticsForTest = {
	buildWorkflowLifecycleDiagnostics,
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
		.where(
			and(eq(benchmarkRuns.projectId, projectId), eq(benchmarkRuns.id, runId)),
		)
		.limit(1);
	if (!run) return null;
	const capacity = capacityFromSummary(run.summary);
	const selectedInstanceCount = instanceCount(run.selectedInstanceIds);
	const [liveSandboxCapacity, parentWorkflowRuntime] = await Promise.all([
		loadSchedulableSandboxCapacitySnapshot(),
		loadParentWorkflowRuntimeSnapshot(),
	]);
	const sharedCapacity = await fetchCapacityObserverSnapshot();
	const clusterPressure = summarizeBenchmarkClusterPressure({
		result: sharedCapacity,
		queueName:
			typeof capacity.executionClass === "string"
				? capacity.executionClass
				: typeof liveSandboxCapacity?.kueueClusterQueueName === "string"
					? liveSandboxCapacity.kueueClusterQueueName
					: null,
	});
	const mergedCapacity = {
		...capacity,
		parentWorkflowRuntime,
		parentWorkflowReplicas: parentWorkflowRuntime.replicas,
		parentWorkflowReadyReplicas: parentWorkflowRuntime.readyReplicas,
		parentWorkflowConnectedWorkers: parentWorkflowRuntime.connectedWorkflowWorkers,
		parentWorkflowConnectedWorkerPods: parentWorkflowRuntime.connectedWorkerPods,
		parentWorkflowLimitPerSidecar: parentWorkflowRuntime.workflowLimitPerSidecar,
		parentActivityLimitPerSidecar: parentWorkflowRuntime.activityLimitPerSidecar,
		parentWorkflowEffectiveCapacity: parentWorkflowRuntime.effectiveWorkflowCapacity,
		parentActivityEffectiveCapacity: parentWorkflowRuntime.effectiveActivityCapacity,
		daprRuntimeVersion: parentWorkflowRuntime.daprRuntimeVersion,
		daprSchedulerPods: parentWorkflowRuntime.schedulerPods,
		daprSchedulerReadyPods: parentWorkflowRuntime.schedulerReadyPods,
		daprRecentActorErrorCount: parentWorkflowRuntime.recentActorErrorCount,
		daprRecentReminderErrorCount: parentWorkflowRuntime.recentReminderErrorCount,
		daprRuntimePressure: parentWorkflowRuntime.daprRuntimePressure,
		clusterPressure,
	};
	const [resources, workflowLifecycle] = await Promise.all([
		loadBenchmarkResourceCapacityDiagnostics({
			run,
			resources: DIAGNOSTIC_RESOURCES,
			liveSandboxCapacity,
		}),
		loadWorkflowLifecycleDiagnostics(run.agentRuntimeAppId),
	]);
	return diagnosticsFromCapacity({
		run,
		capacity: mergedCapacity,
		selectedInstanceCount,
		resources,
		workflowLifecycle,
		sharedCapacity,
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
	executionBackend?: string | null;
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
	const [sandboxCapacity, parentWorkflowRuntime] = await Promise.all([
		loadSchedulableSandboxCapacitySnapshot(),
		loadParentWorkflowRuntimeSnapshot(),
	]);
	const sharedCapacity = await fetchCapacityObserverSnapshot();
	const clusterPressure = summarizeBenchmarkClusterPressure({
		result: sharedCapacity,
		queueName: sandboxCapacity?.kueueClusterQueueName,
	});
	const capacity = estimateBenchmarkRuntimeCapacity({
		runtimeClass: runtimeRoute.runtimeClass,
		runtimeIsolation: runtimeRoute.isolation,
		runtimeAppId: runtimeRoute.appId,
		poolMaxReplicas: runtimeRoute.pool?.maxReplicas,
		slotsPerReplica: runtimeRoute.pool?.slotsPerReplica,
		maxActiveSessions: runtimeRoute.pool?.maxActiveSessions,
		sandboxCapacity,
		clusterPressure,
		parentWorkflowRuntime,
		requestedInstanceCount: selectedInstanceCount,
		requestedConcurrency: input.requestedConcurrency,
		modelNameOrPath:
			input.modelNameOrPath ?? input.modelConfigLabel ?? agent.modelSpec,
		modelConfigLabel: input.modelConfigLabel,
		agentSlug: agent.slug,
		executionBackend: input.executionBackend,
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
		selectedInstanceIds: Array.from(
			{ length: selectedInstanceCount },
			(_, index) => String(index),
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
		mlflowDatasetId: null,
		mlflowEvalRunId: null,
		summary: { capacity },
		tags: [],
		error: null,
		cancelRequestedAt: null,
		startedAt: null,
		completedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as typeof benchmarkRuns.$inferSelect;
	const [resources, workflowLifecycle] = await Promise.all([
		loadBenchmarkResourceCapacityDiagnostics({
			run: pseudoRun,
			resources: DIAGNOSTIC_RESOURCES,
			liveSandboxCapacity: sandboxCapacity,
		}),
		loadWorkflowLifecycleDiagnostics(runtimeRoute.appId),
	]);
	return diagnosticsFromCapacity({
		run: pseudoRun,
		capacity,
		selectedInstanceCount,
		resources,
		workflowLifecycle,
		sharedCapacity,
	});
}
