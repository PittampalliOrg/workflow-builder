import { error } from "@sveltejs/kit";
import { and, eq, inArray, sql } from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import {
	benchmarkResourceLeases,
	benchmarkRuns,
} from "$lib/server/db/schema";
import {
	loadSchedulableSandboxCapacitySnapshot,
	type BenchmarkSandboxCapacitySnapshot,
} from "$lib/server/benchmarks/sandbox-capacity";

export type BenchmarkResourceLeaseTypeInput =
	| "inference_slot"
	| "openshell_sandbox"
	| "agent_runtime_slot"
	| "dapr_workflow_slot"
	| "evaluator_slot"
	| "model_slot";

type BenchmarkResourceLeaseType = BenchmarkResourceLeaseTypeInput;

const INFERENCE_RESOURCES = [
	"inference_slot",
	"openshell_sandbox",
	"agent_runtime_slot",
	"dapr_workflow_slot",
	"model_slot",
] satisfies BenchmarkResourceLeaseType[];

const KUEUE_OPTIONAL_LEASE_RESOURCES = [
	"dapr_workflow_slot",
	"model_slot",
] satisfies BenchmarkResourceLeaseType[];

type BenchmarkRunForLease = typeof benchmarkRuns.$inferSelect;

export type BenchmarkResourceLeaseRequest = {
	runId: string;
	instanceId?: string | null;
	phase?: string | null;
	resources?: BenchmarkResourceLeaseType[] | null;
	leaseSeconds?: number | null;
	metadata?: Record<string, unknown> | null;
};

export type BenchmarkResourceLeaseAdmission = {
	admitted: boolean;
	runId: string;
	instanceId: string | null;
	phase: string;
	holderId: string;
	leases: Array<{
		id: string;
		resourceType: BenchmarkResourceLeaseType;
		capacityKey: string;
		expiresAt: string;
	}>;
	blockedBy?: BenchmarkResourceLeaseType;
	reason?: string;
	active?: number;
	limit?: number;
	retryAfterSeconds?: number;
};

export type BenchmarkResourceCapacityDiagnostic = {
	resourceType: BenchmarkResourceLeaseType;
	capacityKey: string;
	active: number;
	staleActive: number;
	limit: number;
	headroom: number;
	blocked: boolean;
};

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

function envPositiveInt(name: string): number | null {
	return positiveInt(env[name] ?? process.env[name]);
}

function envOptionalPositiveInt(...names: string[]): number | null {
	for (const name of names) {
		const value = envPositiveInt(name);
		if (value) return value;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function leasePhase(value: string | null | undefined): string {
	return (value ?? "inference")
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		|| "inference";
}

function configuredLeaseResources(name: string): BenchmarkResourceLeaseType[] | null {
	const raw = (env[name] ?? process.env[name] ?? "").trim();
	if (!raw) return null;
	const allowed = new Set<BenchmarkResourceLeaseType>([
		"inference_slot",
		"openshell_sandbox",
		"agent_runtime_slot",
		"dapr_workflow_slot",
		"evaluator_slot",
		"model_slot",
	]);
	return raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry): entry is BenchmarkResourceLeaseType =>
			allowed.has(entry as BenchmarkResourceLeaseType),
		);
}

function isKueueManagedRun(run: BenchmarkRunForLease): boolean {
	const summary = isRecord(run.summary) ? run.summary : {};
	const execution = recordValue(summary.execution);
	const backend =
		typeof execution?.backend === "string"
			? execution.backend.trim().toLowerCase().replace(/_/g, "-")
			: "";
	return (
		backend === "dapr-kueue" ||
		backend === "kueue-dapr" ||
		backend === "agent-host-kueue" ||
		backend === "kueue-agent-hosts" ||
		backend === "host" ||
		backend === "host-execution" ||
		backend === "host-execution-plane"
	);
}

function defaultLeaseResources(
	run?: BenchmarkRunForLease | null,
): readonly BenchmarkResourceLeaseType[] {
	if (!run || !isKueueManagedRun(run)) return INFERENCE_RESOURCES;
	const configured = configuredLeaseResources("BENCHMARK_KUEUE_LEASE_RESOURCES");
	if (configured) return configured;
	const capacity = capacitySummary(run);
	return KUEUE_OPTIONAL_LEASE_RESOURCES.filter((resourceType) => {
		if (resourceType === "dapr_workflow_slot") {
			return (
				envOptionalPositiveInt(
					"BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS",
					"BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS",
				) != null ||
				capacityNumber(capacity, "agentWorkflowMaxActiveTurns") != null
			);
		}
		if (resourceType === "model_slot") {
			return (
				envOptionalPositiveInt(
					"BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS",
					"BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS",
				) != null ||
				capacityNumber(capacity, "modelMaxActiveRequests") != null
			);
		}
		return false;
	});
}

function leaseResources(
	resources: BenchmarkResourceLeaseType[] | null | undefined,
	run?: BenchmarkRunForLease | null,
): BenchmarkResourceLeaseType[] {
	const allowed = new Set<BenchmarkResourceLeaseType>([
		"inference_slot",
		"openshell_sandbox",
		"agent_runtime_slot",
		"dapr_workflow_slot",
		"evaluator_slot",
		"model_slot",
	]);
	const defaults = defaultLeaseResources(run);
	const selected = (resources?.length ? resources : defaults).filter(
		(resource): resource is BenchmarkResourceLeaseType => allowed.has(resource),
	);
	return [...new Set(selected)].sort();
}

function capacitySummary(run: BenchmarkRunForLease): Record<string, unknown> {
	const summary = isRecord(run.summary) ? run.summary : {};
	const capacity = summary.capacity;
	return isRecord(capacity) ? capacity : {};
}

function capacityNumber(
	capacity: Record<string, unknown>,
	key: string,
): number | null {
	return positiveInt(capacity[key]);
}

function capacityNonNegativeNumber(
	capacity: Record<string, unknown>,
	key: string,
): number | null {
	return nonNegativeInt(capacity[key]);
}

function recordValue(value: unknown): Record<string, unknown> | null {
	return isRecord(value) ? value : null;
}

function sandboxCapacityLimit(
	capacity: Record<string, unknown>,
	liveSandboxCapacity?: BenchmarkSandboxCapacitySnapshot | null,
): number | null {
	const configured = envPositiveInt("BENCHMARK_MAX_ACTIVE_SANDBOXES");
	const liveTotal = liveSandboxCapacity?.error
		? null
		: nonNegativeInt(liveSandboxCapacity?.totalSchedulableSandboxCapacity);
	const storedSandboxCapacity = recordValue(capacity.sandboxCapacity);
	const storedTotal =
		typeof storedSandboxCapacity?.error === "string"
			? null
			: capacityNonNegativeNumber(
					storedSandboxCapacity ?? {},
					"totalSchedulableSandboxCapacity",
				);
	const storedMaxActive = capacityNonNegativeNumber(capacity, "maxActiveSandboxes");
	const candidates = [configured, liveTotal, storedTotal, storedMaxActive].filter(
		(value): value is number => value != null,
	);
	if (candidates.length === 0) return null;
	return Math.min(...candidates);
}

function daprWorkflowCapacityLimit(
	capacity: Record<string, unknown>,
	effective: number,
): number {
	const candidates = [
		capacityNumber(capacity, "parentWorkflowEffectiveCapacity"),
		envOptionalPositiveInt(
			"BENCHMARK_AGENT_WORKFLOW_MAX_ACTIVE_TURNS",
			"BENCHMARK_MAX_ACTIVE_AGENT_WORKFLOWS",
		),
		capacityNumber(capacity, "agentWorkflowMaxActiveTurns"),
		capacityNumber(capacity, "daprWorkflowEffectiveCapacity"),
		capacityNumber(capacity, "runtimeSlots"),
	].filter((value): value is number => value != null);
	return candidates.length > 0 ? Math.min(...candidates) : effective;
}

function inferenceCapacityLimit(
	capacity: Record<string, unknown>,
	effective: number,
): number {
	return (
		envPositiveInt("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES") ??
		capacityNumber(capacity, "maxActiveInferenceInstances") ??
		effective
	);
}

function resourceCapacity(
	run: BenchmarkRunForLease,
	resourceType: BenchmarkResourceLeaseType,
	liveSandboxCapacity?: BenchmarkSandboxCapacitySnapshot | null,
): { capacityKey: string; limit: number } {
	const capacity = capacitySummary(run);
	const parentWorkflowRuntime = recordValue(capacity.parentWorkflowRuntime);
	const runConcurrency = Math.max(1, positiveInt(run.concurrency) ?? 1);
	const effective = Math.max(
		1,
		capacityNumber(capacity, "effectiveConcurrency") ?? runConcurrency,
	);
	switch (resourceType) {
		case "inference_slot":
			return {
				capacityKey: "workflow-builder",
				limit: inferenceCapacityLimit(capacity, effective),
			};
		case "openshell_sandbox":
			return {
				capacityKey: "openshell",
				limit:
					sandboxCapacityLimit(capacity, liveSandboxCapacity) ??
					effective,
			};
		case "agent_runtime_slot":
			return {
				capacityKey: run.agentRuntimeAppId || "agent-runtime",
				limit:
					capacityNumber(capacity, "maxActiveSessions") ??
					capacityNumber(capacity, "runtimeSlots") ??
					effective,
			};
		case "dapr_workflow_slot":
			return {
				capacityKey:
					typeof parentWorkflowRuntime?.parentAppId === "string"
						? parentWorkflowRuntime.parentAppId
						: "workflow-orchestrator",
				limit: daprWorkflowCapacityLimit(capacity, effective),
			};
		case "evaluator_slot":
			return {
				capacityKey: "swebench-evaluator",
				limit:
					envPositiveInt("SWEBENCH_EVAL_MAX_PARALLEL") ??
					positiveInt(run.evaluationConcurrency) ??
					1,
			};
		case "model_slot":
			return {
				capacityKey: run.modelNameOrPath || run.modelConfigLabel || "model",
				limit:
					envPositiveInt("BENCHMARK_MODEL_MAX_ACTIVE_REQUESTS") ??
					envPositiveInt("BENCHMARK_MAX_ACTIVE_MODEL_REQUESTS") ??
					inferenceCapacityLimit(capacity, effective) ??
					effective,
			};
	}
}

export const __benchmarkResourceLeasesForTest = {
	admissionLimit,
	leaseResources,
	resourceCapacity,
	sandboxCapacityLimit,
};

export async function loadBenchmarkResourceCapacityDiagnostics(params: {
	run: BenchmarkRunForLease;
	resources?: BenchmarkResourceLeaseType[] | null;
	liveSandboxCapacity?: BenchmarkSandboxCapacitySnapshot | null;
}): Promise<BenchmarkResourceCapacityDiagnostic[]> {
	const database = requireDb();
	const resources = leaseResources(params.resources, params.run);
	const liveSandboxCapacity =
		params.liveSandboxCapacity ??
		(resources.includes("openshell_sandbox")
			? await loadSchedulableSandboxCapacitySnapshot()
			: null);
	const requested = resources.map((resourceType) => ({
		resourceType,
		...resourceCapacity(params.run, resourceType, liveSandboxCapacity),
	}));
	if (requested.length === 0) return [];

	const activeRows = await database
		.select({
			resourceType: benchmarkResourceLeases.resourceType,
			capacityKey: benchmarkResourceLeases.capacityKey,
			active: sql<number>`coalesce(sum(${benchmarkResourceLeases.leaseCount}) filter (where ${benchmarkResourceLeases.expiresAt} > now()), 0)::int`,
			staleActive: sql<number>`coalesce(sum(${benchmarkResourceLeases.leaseCount}) filter (where ${benchmarkResourceLeases.expiresAt} <= now()), 0)::int`,
		})
		.from(benchmarkResourceLeases)
		.where(
			and(
				eq(benchmarkResourceLeases.status, "active"),
				inArray(
					benchmarkResourceLeases.resourceType,
					requested.map((resource) => resource.resourceType),
				),
				inArray(
					benchmarkResourceLeases.capacityKey,
					requested.map((resource) => resource.capacityKey),
				),
			),
		)
		.groupBy(
			benchmarkResourceLeases.resourceType,
			benchmarkResourceLeases.capacityKey,
		);
	const activeByResource = new Map(
		activeRows.map((row) => [
			`${row.resourceType}:${row.capacityKey}`,
			{
				active: Number(row.active ?? 0),
				staleActive: Number(row.staleActive ?? 0),
			},
		]),
	);

	return requested.map((resource) => {
		const counts = activeByResource.get(
			`${resource.resourceType}:${resource.capacityKey}`,
		) ?? { active: 0, staleActive: 0 };
		const limit = admissionLimit({
			resourceType: resource.resourceType,
			limit: resource.limit,
			active: counts.active,
			liveSandboxCapacity,
		});
		const headroom = Math.max(0, limit - counts.active);
		return {
			resourceType: resource.resourceType,
			capacityKey: resource.capacityKey,
			active: counts.active,
			staleActive: counts.staleActive,
			limit,
			headroom,
			blocked: counts.active >= limit,
		};
	});
}

function admissionLimit(params: {
	resourceType: BenchmarkResourceLeaseType;
	limit: number;
	active: number;
	liveSandboxCapacity?: BenchmarkSandboxCapacitySnapshot | null;
}): number {
	if (
		params.resourceType !== "openshell_sandbox" ||
		!params.liveSandboxCapacity ||
		params.liveSandboxCapacity.error
	) {
		return params.limit;
	}
	const available = nonNegativeInt(
		params.liveSandboxCapacity.availableSandboxSlots,
	);
	if (available == null) return params.limit;
	const currentSwebenchPods =
		(nonNegativeInt(params.liveSandboxCapacity.activeSwebenchPods) ?? 0) +
		(nonNegativeInt(params.liveSandboxCapacity.pendingSwebenchPods) ?? 0);
	const schedulerLimit = available + Math.min(params.active, currentSwebenchPods);
	return Math.min(params.limit, schedulerLimit);
}

function defaultLeaseSeconds(run: BenchmarkRunForLease): number {
	return (
		envPositiveInt("BENCHMARK_RESOURCE_LEASE_SECONDS") ??
		Math.max(900, (positiveInt(run.timeoutSeconds) ?? 7200) + 900)
	);
}

function leaseHolderId(params: {
	runId: string;
	instanceId?: string | null;
	phase: string;
}): string {
	return `${params.phase}:${params.runId}:${params.instanceId ?? params.runId}`;
}

function addSeconds(date: Date, seconds: number): Date {
	return new Date(date.getTime() + seconds * 1000);
}

export async function acquireBenchmarkResourceLeases(
	params: BenchmarkResourceLeaseRequest,
): Promise<BenchmarkResourceLeaseAdmission> {
	const database = requireDb();
	const phase = leasePhase(params.phase);
	const instanceId =
		typeof params.instanceId === "string" && params.instanceId.trim()
			? params.instanceId.trim()
			: null;
	const holderId = leaseHolderId({ runId: params.runId, instanceId, phase });
	const [planningRun] = await database
		.select()
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, params.runId))
		.limit(1);
	if (!planningRun) throw error(404, "Benchmark run not found");
	const resources = leaseResources(params.resources, planningRun);
	const liveSandboxCapacity = resources.includes("openshell_sandbox")
		? await loadSchedulableSandboxCapacitySnapshot()
		: null;

	return database.transaction(async (tx) => {
		const [run] = await tx
			.select()
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, params.runId))
			.limit(1);
		if (!run) throw error(404, "Benchmark run not found");
		if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
			return {
				admitted: false,
				runId: params.runId,
				instanceId,
				phase,
				holderId,
				leases: [],
				reason: `benchmark_run_${run.status}`,
			};
		}

		const now = new Date();
		const leaseSeconds =
			positiveInt(params.leaseSeconds) ?? defaultLeaseSeconds(run);
		const expiresAt = addSeconds(now, leaseSeconds);

		await tx
			.update(benchmarkResourceLeases)
			.set({ status: "expired", updatedAt: sql`now()` })
			.where(
				and(
					eq(benchmarkResourceLeases.status, "active"),
					sql`${benchmarkResourceLeases.expiresAt} <= now()`,
				),
			);

		const requested = resources.map((resourceType) => ({
			resourceType,
			...resourceCapacity(run, resourceType, liveSandboxCapacity),
		}));

		for (const resource of requested) {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtext(${`benchmark_resource_leases:${resource.resourceType}:${resource.capacityKey}`}))`,
			);
		}

		const activeForHolder =
			resources.length > 0
				? await tx
						.select()
						.from(benchmarkResourceLeases)
						.where(
							and(
								eq(benchmarkResourceLeases.holderId, holderId),
								eq(benchmarkResourceLeases.status, "active"),
								inArray(benchmarkResourceLeases.resourceType, resources),
							),
						)
				: [];
		const existingByResource = new Map(
			activeForHolder.map((lease) => [lease.resourceType, lease]),
		);

		for (const resource of requested) {
			if (existingByResource.has(resource.resourceType)) continue;
			const activeRows = await tx
				.select({
					count: sql<number>`coalesce(sum(${benchmarkResourceLeases.leaseCount}), 0)::int`,
				})
				.from(benchmarkResourceLeases)
				.where(
					and(
						eq(benchmarkResourceLeases.resourceType, resource.resourceType),
						eq(benchmarkResourceLeases.capacityKey, resource.capacityKey),
						eq(benchmarkResourceLeases.status, "active"),
					),
			);
			const active = Number(activeRows[0]?.count ?? 0);
			const limit = admissionLimit({
				resourceType: resource.resourceType,
				limit: resource.limit,
				active,
				liveSandboxCapacity,
			});
			if (active + 1 > limit) {
				return {
					admitted: false,
					runId: params.runId,
					instanceId,
					phase,
					holderId,
					leases: activeForHolder.map((lease) => ({
						id: lease.id,
						resourceType: lease.resourceType,
						capacityKey: lease.capacityKey,
						expiresAt: lease.expiresAt.toISOString(),
					})),
					blockedBy: resource.resourceType,
					reason: "capacity_exhausted",
					active,
					limit,
					retryAfterSeconds: envPositiveInt("BENCHMARK_LEASE_RETRY_SECONDS") ?? 15,
				};
			}
		}

		if (activeForHolder.length > 0) {
			await tx
				.update(benchmarkResourceLeases)
				.set({ heartbeatAt: now, expiresAt, updatedAt: now })
				.where(
					and(
						eq(benchmarkResourceLeases.holderId, holderId),
						eq(benchmarkResourceLeases.status, "active"),
						inArray(benchmarkResourceLeases.resourceType, resources),
					),
				);
		}

		const missing = requested.filter(
			(resource) => !existingByResource.has(resource.resourceType),
		);
		if (missing.length > 0) {
			await tx.insert(benchmarkResourceLeases).values(
				missing.map((resource) => ({
					runId: params.runId,
					instanceId,
					phase,
					resourceType: resource.resourceType,
					capacityKey: resource.capacityKey,
					holderId,
					leaseCount: 1,
					status: "active" as const,
					metadata: params.metadata ?? {},
					acquiredAt: now,
					heartbeatAt: now,
					expiresAt,
					createdAt: now,
					updatedAt: now,
				})),
			);
		}

		const leases = await tx
			.select()
			.from(benchmarkResourceLeases)
			.where(
				and(
					eq(benchmarkResourceLeases.holderId, holderId),
					eq(benchmarkResourceLeases.status, "active"),
					inArray(benchmarkResourceLeases.resourceType, resources),
				),
			);
		return {
			admitted: true,
			runId: params.runId,
			instanceId,
			phase,
			holderId,
			leases: leases.map((lease) => ({
				id: lease.id,
				resourceType: lease.resourceType,
				capacityKey: lease.capacityKey,
				expiresAt: lease.expiresAt.toISOString(),
			})),
		};
	});
}

export async function releaseBenchmarkResourceLeases(params: {
	runId: string;
	instanceId?: string | null;
	phase?: string | null;
	holderId?: string | null;
	resources?: BenchmarkResourceLeaseType[] | null;
	reason?: string | null;
}) {
	const database = requireDb();
	const now = new Date();
	const conditions = [
		eq(benchmarkResourceLeases.runId, params.runId),
		eq(benchmarkResourceLeases.status, "active"),
	];
	const phase = params.phase ? leasePhase(params.phase) : null;
	if (phase) conditions.push(eq(benchmarkResourceLeases.phase, phase));
	if (params.holderId?.trim()) {
		conditions.push(eq(benchmarkResourceLeases.holderId, params.holderId.trim()));
	} else if (params.instanceId?.trim()) {
		conditions.push(eq(benchmarkResourceLeases.instanceId, params.instanceId.trim()));
	}
	const resources = params.resources?.length ? leaseResources(params.resources) : null;
	if (resources?.length) {
		conditions.push(inArray(benchmarkResourceLeases.resourceType, resources));
	}
	const patch: Partial<typeof benchmarkResourceLeases.$inferInsert> = {
		status: "released",
		releasedAt: now,
		updatedAt: now,
	};
	if (params.reason) patch.metadata = { releaseReason: params.reason };
	const released = await database
		.update(benchmarkResourceLeases)
		.set(patch)
		.where(and(...conditions))
		.returning({ id: benchmarkResourceLeases.id });
	return { released: released.length };
}

export async function releaseBenchmarkResourceLeasesForRun(
	runId: string,
	reason: string,
) {
	return releaseBenchmarkResourceLeases({ runId, reason });
}

export async function benchmarkResourceLeaseSnapshot(runId?: string | null) {
	const database = requireDb();
	const rows = await database
		.select()
		.from(benchmarkResourceLeases)
		.where(
			runId
				? and(
						eq(benchmarkResourceLeases.runId, runId),
						eq(benchmarkResourceLeases.status, "active"),
					)
				: eq(benchmarkResourceLeases.status, "active"),
		);
	const resources: Record<string, number> = {};
	for (const row of rows) {
		const key = `${row.resourceType}:${row.capacityKey}`;
		resources[key] = (resources[key] ?? 0) + row.leaseCount;
	}
	return {
		activeLeases: rows.length,
		resources,
		leases: rows.map((row) => ({
			id: row.id,
			runId: row.runId,
			instanceId: row.instanceId,
			phase: row.phase,
			resourceType: row.resourceType,
			capacityKey: row.capacityKey,
			holderId: row.holderId,
			expiresAt: row.expiresAt.toISOString(),
		})),
	};
}
