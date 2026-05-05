import { createHash } from "node:crypto";
import { error } from "@sveltejs/kit";
import {
	asc,
	and,
	count,
	desc,
	eq,
	inArray,
	or,
	sql,
	type SQL,
} from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import { costFor, type UsageTotals } from "$lib/server/pricing/model-pricing";
import {
	aggregateBenchmarkLifecycleFromSessionEvents,
	aggregateLlmUsageFromSessionEvents,
} from "$lib/server/sessions/events";
import { runScorersForRun } from "./score-runner";
import {
	agentVersions,
	agents,
	benchmarkArtifacts,
	benchmarkInstances,
	benchmarkRunInstances,
	benchmarkRuns,
	benchmarkSuites,
	environmentImageBuilds,
	sessionEvents,
	sessions,
	workflowExecutionLogs,
	workflowExecutions,
	workflows,
	type BenchmarkEvaluationStatus,
	type BenchmarkInferenceStatus,
	type BenchmarkRunInstanceStatus,
	type BenchmarkRunStatus,
} from "$lib/server/db/schema";
import {
	daprFetch,
	getDaprSidecarUrl,
	getOrchestratorUrl,
} from "$lib/server/dapr-client";
import { isAgentRuntimeSandboxName } from "$lib/server/agent-runtime-sandboxes";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { resolveSpecAgentRefs } from "$lib/server/agents/resolver";
import { resolveAgentRuntimeRoute } from "$lib/server/agents/runtime-routing";
import type { AgentConfig } from "$lib/types/agents";
import {
	assertDaprAgentPyBenchmarkAgent,
	type ValidBenchmarkAgent,
} from "./agents";
import { estimateBenchmarkRuntimeCapacity } from "./runtime-capacity";
import { loadSchedulableSandboxCapacitySnapshot } from "./sandbox-capacity";
import { aggregateBenchmarkInstanceTimings } from "./timings";
import {
	buildSwebenchDatasetJsonl,
	buildPredictionsJsonl,
	buildSwebenchPrediction,
	canTransitionBenchmarkRun,
	findMissingSwebenchMetadata,
	INSTANCE_TERMINAL_STATUSES,
	isCompleteSwebenchInstanceMetadata,
	normalizeInstanceIds,
	normalizeSwebenchSuiteSlug,
	summarizeRunInstances,
	SWEBENCH_ALLOWED_AGENT_TOOLS,
	SWEBENCH_SUITES,
	type SwebenchSuiteSlug,
} from "./swebench";
import {
	loadSwebenchInferenceEnvironmentMappings,
	resolveSwebenchInferenceEnvironment,
	swebenchInferenceEnvironmentPromptNotes,
	type ResolvedSwebenchInferenceEnvironment,
} from "./inference-environments";
import { buildStableWorkspaceRef } from "./workspace-ref";
import {
	ensureBenchmarkInstanceMlflowRun,
	ensureBenchmarkMlflowRun,
	publicMlflowRunUrl,
	syncBenchmarkInstanceMlflow,
	syncBenchmarkRunMlflow,
} from "./mlflow";
import {
	logBenchmarkTraceSummaryArtifact,
	materializeSwebenchTraceBundle,
} from "./trace-bundle";
import { releaseBenchmarkResourceLeasesForRun } from "./resource-leases";

const HIDDEN_WORKFLOW_NAME = "SWE-bench instance runner";
const DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60;
const BENCHMARK_TERMINATION_CONCURRENCY = 8;
const BENCHMARK_TERMINATION_REQUEST_TIMEOUT_MS = 20_000;
const BENCHMARK_TERMINATION_WAIT_POLL_MS = 1_000;
const BENCHMARK_TERMINATION_WAIT_SECONDS = 120;
const TERMINAL_DURABLE_RUNTIME_STATUSES = new Set([
	"CANCELED",
	"CANCELLED",
	"COMPLETED",
	"FAILED",
	"TERMINATED",
]);

async function syncBenchmarkInstanceMlflowAndTraceBundle(params: {
	runId: string;
	instanceId: string;
}): Promise<void> {
	await syncBenchmarkInstanceMlflow(params);
	try {
		await materializeSwebenchTraceBundle(params);
	} catch (err) {
		console.warn(
			`[trace-bundle] failed to materialize ${params.runId}/${params.instanceId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}
const DURABLE_RUNTIME_MISSING_STATUS = "__missing__";
const BENCHMARK_SANDBOX_CLEANUP_CONCURRENCY = 8;

type BenchmarkAgentRuntimeCleanupInput = {
	runtimeAppId: string | null;
	sessionId: string | null;
	turnCount: number | null;
};

type BenchmarkSessionTurnInput = {
	sessionId: string;
	childInstanceId: string | null;
	turn: number | null;
};
const DEFAULT_EVALUATION_CONCURRENCY = 24;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const SWEBENCH_FALLBACK_WORKSPACE_ROOT = "/sandbox";
const SWEBENCH_FALLBACK_REPO_PATH = "/sandbox/repo";
const SWEBENCH_SANDBOX_TTL_SECONDS_FALLBACK = 2 * 60 * 60;
const SWEBENCH_PATCH_EXCLUDE_PATHS = [
	":(exclude)**/tests/**",
	":(exclude)tests/**",
	":(exclude)test/**",
	":(exclude)testing/**",
	":(exclude)**/test_*.py",
	":(exclude)**/*_test.py",
	":(exclude)**/conftest.py",
	":(exclude)**/fixtures/**",
];
const ACTIVE_BENCHMARK_INSTANCE_STATUSES = [
	"queued",
	"inferencing",
	"inferred",
	"evaluating",
] satisfies BenchmarkRunInstanceStatus[];
const BENCHMARK_RUN_TERMINAL_STATUSES = new Set<BenchmarkRunStatus>([
	"completed",
	"failed",
	"cancelled",
]);
const BENCHMARK_RUN_SUMMARY_STATUS_KEYS = [
	"queued",
	"inferencing",
	"inferred",
	"evaluating",
	"resolved",
	"failed",
	"error",
	"timeout",
	"cancelled",
] satisfies BenchmarkRunInstanceStatus[];
type ExecutionStatus =
	| "pending"
	| "running"
	| "success"
	| "error"
	| "timeout"
	| "cancelled";
type CompletedExecutionStatus = Exclude<ExecutionStatus, "pending" | "running">;
type BenchmarkRunTerminalOutcome = Extract<
	BenchmarkRunStatus,
	"failed" | "cancelled"
>;
type BenchmarkRunInstanceTerminalInput = {
	status: BenchmarkRunInstanceStatus;
	inferenceStatus: BenchmarkInferenceStatus;
	evaluationStatus: BenchmarkEvaluationStatus;
	error: string | null;
	inferenceError: string | null;
	evaluationError: string | null;
	terminationReason: string | null;
	inferenceCompletedAt: Date | null;
	evaluatedAt: Date | null;
};

function requireDb() {
	if (!db) throw error(503, "Database not configured");
	return db;
}

export function shouldFinalizeBenchmarkLifecycle(row: {
	status: BenchmarkRunInstanceStatus;
	inferenceStatus: BenchmarkInferenceStatus;
}): boolean {
	return (
		INSTANCE_TERMINAL_STATUSES.has(row.status) ||
		(row.inferenceStatus !== "queued" && row.inferenceStatus !== "inferencing")
	);
}

export function isBenignDaprTerminationMiss(input: unknown): boolean {
	let text = "";
	if (typeof input === "string") {
		text = input;
	} else if (input instanceof Error) {
		text = `${input.name} ${input.message}`;
	} else if (input != null) {
		try {
			text = JSON.stringify(input) ?? String(input);
		} catch {
			text = String(input);
		}
	}
	const normalized = text.toLowerCase();
	return (
		normalized.includes("no such instance exists") ||
		normalized.includes("agent run not found") ||
		normalized.includes("workflow instance not found") ||
		(normalized.includes("failed to resolve address") &&
			normalized.includes("no such host")) ||
		(normalized.includes("failed to invoke") &&
			normalized.includes("-dapr") &&
			normalized.includes("no such host"))
	);
}

function isTerminalDurableRuntimeStatus(status: unknown): boolean {
	return TERMINAL_DURABLE_RUNTIME_STATUSES.has(String(status ?? "").toUpperCase());
}

function durableRuntimeStatusFromBody(body: unknown): unknown {
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const record = body as Record<string, unknown>;
	return (
		record.runtimeStatus ??
		record.runtime_status ??
		record.status ??
		record.workflowStatus ??
		null
	);
}

function benchmarkTerminationWaitMs(): number {
	return (
		clampInteger(
			env.BENCHMARK_TERMINATION_WAIT_SECONDS,
			0,
			10 * 60,
			BENCHMARK_TERMINATION_WAIT_SECONDS,
		) * 1000
	);
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDurableRuntimeClosed(
	label: string,
	fetchStatus: () => Promise<unknown>,
): Promise<boolean> {
	const waitMs = benchmarkTerminationWaitMs();
	if (waitMs <= 0) return false;
	const deadline = Date.now() + waitMs;
	let lastStatus: unknown = null;
	while (Date.now() < deadline) {
		const status = await fetchStatus().catch((err) => {
			if (isBenignDaprTerminationMiss(err)) {
				return DURABLE_RUNTIME_MISSING_STATUS;
			}
			console.warn(
				`Failed to poll ${label} shutdown status:`,
				err instanceof Error ? err.message : err,
			);
			return null;
		});
		if (
			status === DURABLE_RUNTIME_MISSING_STATUS ||
			isTerminalDurableRuntimeStatus(status)
		) {
			return true;
		}
		lastStatus = status;
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await sleep(Math.min(BENCHMARK_TERMINATION_WAIT_POLL_MS, remaining));
	}
	console.warn(
		`Timed out waiting for ${label} to stop before purge${
			lastStatus ? ` (last status: ${String(lastStatus)})` : ""
		}`,
	);
	return false;
}

export function benchmarkAgentRuntimeCleanupInstanceIds(
	row: BenchmarkAgentRuntimeCleanupInput,
	turns?: BenchmarkSessionTurnInput | BenchmarkSessionTurnInput[] | null,
): string[] {
	const sessionId = row.sessionId?.trim();
	if (!row.runtimeAppId || !sessionId) return [];
	const ids = new Set<string>([sessionId]);
	const knownTurns = Array.isArray(turns) ? turns : turns ? [turns] : [];
	const maxKnownTurn = knownTurns.reduce((max, turn) => {
		return typeof turn.turn === "number" && turn.turn > max ? turn.turn : max;
	}, 0);
	const turnCount =
		maxKnownTurn > 0
			? maxKnownTurn
			: typeof row.turnCount === "number" && row.turnCount > 0
				? row.turnCount
				: 1;
	for (let turn = 1; turn <= Math.min(Math.floor(turnCount), 1000); turn += 1) {
		ids.add(`${sessionId}:turn-${turn}`);
	}
	for (const turn of knownTurns) {
		const child = turn.childInstanceId?.trim();
		if (child) ids.add(child);
	}
	return [...ids];
}

async function runWithConcurrency<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
) {
	const pending = [...items];
	const concurrency = Math.max(1, Math.min(limit, pending.length));
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (pending.length > 0) {
				const item = pending.shift();
				if (item === undefined) return;
				await worker(item);
			}
		}),
	);
}

export async function ensureDefaultBenchmarkSuites() {
	const database = requireDb();
	for (const suite of SWEBENCH_SUITES) {
		await database
			.insert(benchmarkSuites)
			.values({
				id: suite.id,
				slug: suite.slug,
				name: suite.name,
				description: suite.description,
				datasetName: suite.datasetName,
				datasetSplit: suite.datasetSplit,
				sourceUrl: suite.sourceUrl,
				defaultInstanceLimit: suite.defaultInstanceLimit,
				metadata: suite.metadata,
			})
			.onConflictDoUpdate({
				target: benchmarkSuites.slug,
				set: {
					name: suite.name,
					description: suite.description,
					datasetName: suite.datasetName,
					datasetSplit: suite.datasetSplit,
					sourceUrl: suite.sourceUrl,
					defaultInstanceLimit: suite.defaultInstanceLimit,
					metadata: suite.metadata,
					updatedAt: new Date(),
				},
			});
	}
}

export async function listBenchmarkSuites(projectId?: string | null) {
	const database = requireDb();
	await ensureDefaultBenchmarkSuites();
	const suites = await database
		.select()
		.from(benchmarkSuites)
		.orderBy(benchmarkSuites.name);
	const suiteIds = suites.map((s) => s.id);
	const instanceCounts = suiteIds.length
		? await database
				.select({ suiteId: benchmarkInstances.suiteId, total: count() })
				.from(benchmarkInstances)
				.where(inArray(benchmarkInstances.suiteId, suiteIds))
				.groupBy(benchmarkInstances.suiteId)
		: [];
	const runCounts =
		projectId && suiteIds.length
			? await database
					.select({ suiteId: benchmarkRuns.suiteId, total: count() })
					.from(benchmarkRuns)
					.where(
						and(
							eq(benchmarkRuns.projectId, projectId),
							inArray(benchmarkRuns.suiteId, suiteIds),
						),
					)
					.groupBy(benchmarkRuns.suiteId)
			: [];
	const environmentCoverage = suiteIds.length
		? await benchmarkEnvironmentCoverage(suites)
		: new Map<string, BenchmarkEnvironmentCoverage>();
	const instancesBySuite = new Map(instanceCounts.map((r) => [r.suiteId, r.total]));
	const runsBySuite = new Map(runCounts.map((r) => [r.suiteId, r.total]));
	return suites.map((suite) => ({
		id: suite.id,
		slug: suite.slug,
		name: suite.name,
		description: suite.description,
		datasetName: suite.datasetName,
		datasetSplit: suite.datasetSplit,
		sourceUrl: suite.sourceUrl,
		defaultInstanceLimit: suite.defaultInstanceLimit,
		instanceCount: instancesBySuite.get(suite.id) ?? 0,
		runCount: runsBySuite.get(suite.id) ?? 0,
		environmentCoverage: environmentCoverage.get(suite.id) ?? emptyBenchmarkEnvironmentCoverage(),
	}));
}

type BenchmarkEnvironmentCoverage = {
	totalRequired: number;
	validated: number;
	building: number;
	failed: number;
	notBuilt: number;
};

type EnvironmentCoverageBucket = {
	required: Set<string>;
	validated: Set<string>;
	building: Set<string>;
	failed: Set<string>;
};

async function benchmarkEnvironmentCoverage(
	suites: Array<typeof benchmarkSuites.$inferSelect>,
): Promise<Map<string, BenchmarkEnvironmentCoverage>> {
	const database = requireDb();
	const suiteIds = suites.map((suite) => suite.id);
	const suiteById = new Map(suites.map((suite) => [suite.id, suite]));
	const suiteIdBySlug = new Map(suites.map((suite) => [suite.slug, suite.id]));
	const staticMappings = loadSwebenchInferenceEnvironmentMappings();
	const buckets = new Map<string, EnvironmentCoverageBucket>(
		suites.map((suite) => [
			suite.id,
			{
				required: new Set<string>(),
				validated: new Set<string>(),
				building: new Set<string>(),
				failed: new Set<string>(),
			},
		]),
	);

	const instances = await database
		.select({
			suiteId: benchmarkInstances.suiteId,
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			testMetadata: benchmarkInstances.testMetadata,
		})
		.from(benchmarkInstances)
		.where(inArray(benchmarkInstances.suiteId, suiteIds));
	for (const instance of instances) {
		const bucket = buckets.get(instance.suiteId);
		const suite = suiteById.get(instance.suiteId);
		const key = benchmarkEnvironmentKey({
			repo: instance.repo,
			baseCommit: instance.baseCommit,
			metadata: instance.testMetadata,
		});
		if (!bucket || !suite || !key || !instance.repo || !instance.baseCommit) continue;
		bucket.required.add(key);
		const resolved = resolveSwebenchInferenceEnvironment(
			{
				suiteSlug: normalizeSwebenchSuiteSlug(suite.slug),
				repo: instance.repo,
				baseCommit: instance.baseCommit,
				testMetadata: instance.testMetadata,
			},
			{ mappings: staticMappings },
		);
		if (resolved.environmentStatus === "validated") bucket.validated.add(key);
	}

	const builds = await database
		.select({
			suite: environmentImageBuilds.suite,
			repo: environmentImageBuilds.repo,
			version: environmentImageBuilds.version,
			environmentSetupCommit: environmentImageBuilds.environmentSetupCommit,
			baseCommit: environmentImageBuilds.baseCommit,
			status: environmentImageBuilds.status,
			validationStatus: environmentImageBuilds.validationStatus,
			sandboxImage: environmentImageBuilds.sandboxImage,
			digest: environmentImageBuilds.digest,
		})
		.from(environmentImageBuilds)
		.where(inArray(environmentImageBuilds.suite, suites.map((suite) => suite.slug)));
	for (const build of builds) {
		const suiteId = build.suite ? suiteIdBySlug.get(build.suite) : undefined;
		const bucket = suiteId ? buckets.get(suiteId) : undefined;
		const key = benchmarkEnvironmentKey({
			repo: build.repo,
			baseCommit: build.baseCommit,
			metadata: {
				version: build.version,
				environmentSetupCommit: build.environmentSetupCommit,
			},
		});
		if (!bucket || !key || !bucket.required.has(key)) continue;
		if (
			build.status === "validated" &&
			build.validationStatus === "validated" &&
			build.sandboxImage &&
			build.digest
		) {
			bucket.validated.add(key);
			continue;
		}
		if (build.status === "queued" || build.status === "building") {
			bucket.building.add(key);
		} else if (build.status === "failed" || build.status === "cancelled") {
			bucket.failed.add(key);
		}
	}

	return new Map(
		Array.from(buckets, ([suiteId, bucket]) => {
			const validated = bucket.validated.size;
			const building = differenceSize(bucket.building, bucket.validated);
			const failed = differenceSize(bucket.failed, new Set([...bucket.validated, ...bucket.building]));
			const accounted = validated + building + failed;
			const totalRequired = bucket.required.size;
			return [
				suiteId,
				{
					totalRequired,
					validated,
					building,
					failed,
					notBuilt: Math.max(totalRequired - accounted, 0),
				},
			];
		}),
	);
}

function emptyBenchmarkEnvironmentCoverage(): BenchmarkEnvironmentCoverage {
	return {
		totalRequired: 0,
		validated: 0,
		building: 0,
		failed: 0,
		notBuilt: 0,
	};
}

function benchmarkEnvironmentKey(input: {
	repo: string | null;
	baseCommit: string | null;
	metadata: Record<string, unknown> | null;
}): string | null {
	if (!input.repo) return null;
	const version = metadataString(input.metadata, "version");
	const environmentSetupCommit =
		metadataString(input.metadata, "environmentSetupCommit") ??
		metadataString(input.metadata, "environment_setup_commit");
	const selector = version ?? environmentSetupCommit?.slice(0, 12) ?? input.baseCommit?.slice(0, 12);
	if (!selector) return null;
	return `${input.repo}::${selector}`;
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | null {
	const value = metadata?.[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function differenceSize(values: Set<string>, excluded: Set<string>): number {
	let size = 0;
	for (const value of values) {
		if (!excluded.has(value)) size += 1;
	}
	return size;
}

export type CreateBenchmarkRunInput = {
	projectId: string;
	userId: string;
	suiteSlug: string;
	agentId: string;
	agentVersion?: number;
	instanceIds: unknown;
	modelNameOrPath?: string;
	modelConfigLabel?: string | null;
	concurrency?: number;
	evaluationConcurrency?: number;
	timeoutSeconds?: number;
	maxTurns?: number | null;
	evaluatorResourceClass?: string | null;
	tags?: string[] | null;
	requirePrevalidatedEnvironments?: boolean;
};

function strictEnvironmentBuildKey(input: {
	suiteSlug: string;
	repo: string | null;
	baseCommit: string | null;
	metadata: Record<string, unknown> | null;
}): string | null {
	if (!input.repo?.trim() || !input.baseCommit?.trim()) return null;
	const version = metadataString(input.metadata, "version");
	const environmentSetupCommit =
		metadataString(input.metadata, "environmentSetupCommit") ??
		metadataString(input.metadata, "environment_setup_commit");
	return [
		input.suiteSlug.trim(),
		input.repo.trim(),
		input.baseCommit.trim(),
		version ?? "",
		environmentSetupCommit ?? "",
	].join("\u0000");
}

function isStrictStaticEnvironmentValidated(input: {
	suiteSlug: SwebenchSuiteSlug;
	repo: string | null;
	baseCommit: string | null;
	metadata: Record<string, unknown> | null;
	staticMappings: ReturnType<typeof loadSwebenchInferenceEnvironmentMappings>;
}): boolean {
	if (!input.repo || !input.baseCommit) return false;
	const version = metadataString(input.metadata, "version");
	const environmentSetupCommit =
		metadataString(input.metadata, "environmentSetupCommit") ??
		metadataString(input.metadata, "environment_setup_commit");
	const resolved = resolveSwebenchInferenceEnvironment(
		{
			suiteSlug: input.suiteSlug,
			repo: input.repo,
			baseCommit: input.baseCommit,
			testMetadata: input.metadata,
		},
		{ mappings: input.staticMappings },
	);
	if (resolved.environmentStatus !== "validated") return false;
	if (resolved.suite !== input.suiteSlug) return false;
	if (resolved.repo !== input.repo) return false;
	if (resolved.baseCommit !== input.baseCommit) return false;
	if (version && resolved.version !== version) return false;
	if (
		environmentSetupCommit &&
		resolved.environmentSetupCommit !== environmentSetupCommit
	) {
		return false;
	}
	return true;
}

async function assertPrevalidatedBenchmarkEnvironments(input: {
	suiteSlug: SwebenchSuiteSlug;
	instances: Array<typeof benchmarkInstances.$inferSelect>;
}) {
	const database = requireDb();
	const staticMappings = loadSwebenchInferenceEnvironmentMappings();
	const missingKeys = new Map<string, string>();
	const requiredKeys = new Set<string>();
	for (const instance of input.instances) {
		if (
			isStrictStaticEnvironmentValidated({
				suiteSlug: input.suiteSlug,
				repo: instance.repo,
				baseCommit: instance.baseCommit,
				metadata: instance.testMetadata,
				staticMappings,
			})
		) {
			continue;
		}
		const key = strictEnvironmentBuildKey({
			suiteSlug: input.suiteSlug,
			repo: instance.repo,
			baseCommit: instance.baseCommit,
			metadata: instance.testMetadata,
		});
		if (!key) {
			missingKeys.set(instance.instanceId, "missing environment identity");
			continue;
		}
		requiredKeys.add(key);
		missingKeys.set(instance.instanceId, key);
	}
	if (missingKeys.size === 0) return;
	const repos = Array.from(
		new Set(
			input.instances
				.map((instance) => instance.repo)
				.filter((repo): repo is string => Boolean(repo)),
		),
	);
	const builds = repos.length
		? await database
				.select({
					suite: environmentImageBuilds.suite,
					repo: environmentImageBuilds.repo,
					baseCommit: environmentImageBuilds.baseCommit,
					version: environmentImageBuilds.version,
					environmentSetupCommit:
						environmentImageBuilds.environmentSetupCommit,
					status: environmentImageBuilds.status,
					validationStatus: environmentImageBuilds.validationStatus,
					sandboxImage: environmentImageBuilds.sandboxImage,
					digest: environmentImageBuilds.digest,
				})
				.from(environmentImageBuilds)
				.where(
					and(
						eq(environmentImageBuilds.suite, input.suiteSlug),
						inArray(environmentImageBuilds.repo, repos),
					),
				)
		: [];
	const validatedKeys = new Set<string>();
	for (const build of builds) {
		if (
			build.status !== "validated" ||
			build.validationStatus !== "validated" ||
			!build.sandboxImage ||
			!build.digest
		) {
			continue;
		}
		const key = [
			build.suite?.trim() ?? "",
			build.repo.trim(),
			build.baseCommit?.trim() ?? "",
			build.version?.trim() ?? "",
			build.environmentSetupCommit?.trim() ?? "",
		].join("\u0000");
		if (requiredKeys.has(key)) validatedKeys.add(key);
	}
	const missingInstances = Array.from(missingKeys)
		.filter(([, key]) => !validatedKeys.has(key))
		.map(([instanceId]) => instanceId);
	if (missingInstances.length > 0) {
		throw error(
			409,
			`Random SWE-bench runs require prevalidated inference environments; ${missingInstances.length} selected instance(s) are not ready: ${missingInstances.slice(0, 20).join(", ")}`,
		);
	}
}

function normalizeTags(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const v of value) {
		if (typeof v !== "string") continue;
		const tag = v.trim().toLowerCase().slice(0, 64);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
	}
	return out;
}

export async function createBenchmarkRun(input: CreateBenchmarkRunInput) {
	const database = requireDb();
	await ensureDefaultBenchmarkSuites();

	const suiteSlug = normalizeSwebenchSuiteSlug(input.suiteSlug);
	const [suite] = await database
		.select()
		.from(benchmarkSuites)
		.where(eq(benchmarkSuites.slug, suiteSlug))
		.limit(1);
	if (!suite) throw error(400, `Unsupported benchmark suite: ${suiteSlug}`);

	const agent = await resolveBenchmarkAgent({
		projectId: input.projectId,
		agentId: input.agentId,
		version: input.agentVersion,
		requestedModelNameOrPath:
			input.modelNameOrPath ?? input.modelConfigLabel ?? null,
	});

	const instanceIds = normalizeInstanceIds(input.instanceIds);
	if (instanceIds.length === 0) {
		throw error(400, "At least one SWE-bench instance id is required");
	}
	if (instanceIds.length > 500) {
		throw error(400, "A benchmark run may include at most 500 instances");
	}
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
		requestedInstanceCount: instanceIds.length,
		requestedConcurrency: input.concurrency,
	});
	const { evaluationConcurrency } = effectiveBenchmarkConcurrency({
		instanceCount: instanceIds.length,
		concurrency: capacity.effectiveConcurrency,
		evaluationConcurrency: input.evaluationConcurrency,
	});
	const concurrency = capacity.effectiveConcurrency;
	const timeoutSeconds = clampInteger(
		input.timeoutSeconds,
		60,
		24 * 60 * 60,
		DEFAULT_TIMEOUT_SECONDS,
	);
	const maxTurns =
		input.maxTurns == null
			? null
			: clampInteger(input.maxTurns, 1, 1000, input.maxTurns);
	const evaluatorResourceClass =
		input.evaluatorResourceClass?.trim() || "standard";
	const modelNameOrPath =
		input.modelNameOrPath?.trim() ||
		input.modelConfigLabel?.trim() ||
		agent.modelSpec ||
		`${agent.slug}@v${agent.version}`;
	const existingInstances = await database
		.select()
		.from(benchmarkInstances)
		.where(
			and(
				eq(benchmarkInstances.suiteId, suite.id),
				inArray(benchmarkInstances.instanceId, instanceIds),
			),
		);
	const missingMetadata = findMissingSwebenchMetadata(
		instanceIds,
		existingInstances,
	);
	if (missingMetadata.length > 0) {
		throw error(
			409,
			`SWE-bench metadata has not been imported for ${missingMetadata.length} selected instance(s): ${missingMetadata.slice(0, 20).join(", ")}`,
		);
	}
	const instancesById = new Map(
		existingInstances.map((instance) => [instance.instanceId, instance]),
	);
	const instanceRows = instanceIds.map((instanceId) => instancesById.get(instanceId)!);
	if (input.requirePrevalidatedEnvironments) {
		await assertPrevalidatedBenchmarkEnvironments({
			suiteSlug,
			instances: instanceRows,
		});
	}

	const created = await database.transaction(async (tx) => {
		const [run] = await tx
			.insert(benchmarkRuns)
			.values({
				projectId: input.projectId,
				userId: input.userId,
				suiteId: suite.id,
				agentId: agent.id,
				agentVersion: agent.version,
				agentRuntime: agent.runtime,
				agentRuntimeAppId: runtimeRoute.appId,
				status: "queued",
				modelNameOrPath,
				modelConfigLabel: input.modelConfigLabel?.trim() || null,
				selectedInstanceIds: instanceIds,
				concurrency,
				evaluationConcurrency,
				timeoutSeconds,
				maxTurns,
				evaluatorResourceClass,
				summary: {
					total: instanceIds.length,
					resolvedRate: 0,
					capacity,
				},
				tags: normalizeTags(input.tags),
			})
			.returning();

		await tx.insert(benchmarkRunInstances).values(
			instanceRows.map((instanceRow) => ({
				runId: run.id,
				benchmarkInstanceId: instanceRow.id,
				instanceId: instanceRow.instanceId,
				status: "queued" as const,
				inferenceStatus: "queued" as const,
				evaluationStatus: "pending" as const,
			})),
		);

		return run;
	});

	await ensureBenchmarkMlflowRun(created.id);
	return created;
}

export async function listBenchmarkRuns(
	projectId: string,
	limit = 20,
	options: { tag?: string | null } = {},
) {
	const database = requireDb();
	await ensureDefaultBenchmarkSuites();
	const conditions: SQL[] = [eq(benchmarkRuns.projectId, projectId)];
	const tag = options.tag?.trim().toLowerCase();
	if (tag) {
		conditions.push(
			sql`${benchmarkRuns.tags} @> ${JSON.stringify([tag])}::jsonb`,
		);
	}
	const rows = await database
		.select({
			run: benchmarkRuns,
			suiteSlug: benchmarkSuites.slug,
			suiteName: benchmarkSuites.name,
			datasetName: benchmarkSuites.datasetName,
			agentName: agents.name,
			agentSlug: agents.slug,
		})
		.from(benchmarkRuns)
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(conditions.length === 1 ? conditions[0] : and(...conditions))
		.orderBy(desc(benchmarkRuns.createdAt))
		.limit(Math.min(Math.max(limit, 1), 100));
	return rows.map((row) => serializeRunSummary(row));
}

export async function getBenchmarkRun(projectId: string, runId: string) {
	const database = requireDb();
	const [row] = await database
		.select({
			run: benchmarkRuns,
			suiteSlug: benchmarkSuites.slug,
			suiteName: benchmarkSuites.name,
			datasetName: benchmarkSuites.datasetName,
			agentName: agents.name,
			agentSlug: agents.slug,
		})
		.from(benchmarkRuns)
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(and(eq(benchmarkRuns.projectId, projectId), eq(benchmarkRuns.id, runId)))
		.limit(1);
	if (!row) return null;

	const [instancesRows, artifactRows] = await Promise.all([
		database
			.select({
				runInstance: benchmarkRunInstances,
				repo: benchmarkInstances.repo,
				baseCommit: benchmarkInstances.baseCommit,
				problemStatement: benchmarkInstances.problemStatement,
				testMetadata: benchmarkInstances.testMetadata,
			})
			.from(benchmarkRunInstances)
			.leftJoin(
				benchmarkInstances,
				eq(benchmarkInstances.id, benchmarkRunInstances.benchmarkInstanceId),
			)
			.where(eq(benchmarkRunInstances.runId, runId))
			.orderBy(benchmarkRunInstances.createdAt),
		database
			.select()
			.from(benchmarkArtifacts)
			.where(eq(benchmarkArtifacts.runId, runId))
			.orderBy(desc(benchmarkArtifacts.createdAt)),
	]);

	return {
		...serializeRunSummary(row),
		instances: instancesRows.map(
			({ runInstance, repo, baseCommit, problemStatement, testMetadata }) => ({
				id: runInstance.id,
				instanceId: runInstance.instanceId,
				status: runInstance.status,
				inferenceStatus: runInstance.inferenceStatus,
				evaluationStatus: runInstance.evaluationStatus,
				repo,
				baseCommit,
				problemStatement,
				testMetadata,
				sessionId: runInstance.sessionId,
				workflowExecutionId: runInstance.workflowExecutionId,
				daprInstanceId: runInstance.daprInstanceId,
				mlflowRunId: runInstance.mlflowRunId,
				mlflowUrl: publicMlflowRunUrl(
					row.run.mlflowExperimentId,
					runInstance.mlflowRunId,
				),
				sandboxName: runInstance.sandboxName,
				workspaceRef: runInstance.workspaceRef,
				traceIds: runInstance.traceIds,
				usage: runInstance.usage,
				timings: runInstance.timings,
				modelPatch: runInstance.modelPatch,
				patchBytes: runInstance.patchBytes,
				error: runInstance.error,
				inferenceError: runInstance.inferenceError,
				evaluationError: runInstance.evaluationError,
				logsPath: runInstance.logsPath,
				testOutputSummary: runInstance.testOutputSummary,
				harnessResult: runInstance.harnessResult,
				inferenceEnvironment: runInstance.inferenceEnvironment,
				startedAt: runInstance.startedAt?.toISOString() ?? null,
				inferenceCompletedAt:
					runInstance.inferenceCompletedAt?.toISOString() ?? null,
				evaluatedAt: runInstance.evaluatedAt?.toISOString() ?? null,
			}),
		),
		artifacts: artifactRows.map((artifact) => ({
			id: artifact.id,
			kind: artifact.kind,
			path: artifact.path,
			contentType: artifact.contentType,
			sizeBytes: artifact.sizeBytes,
			sha256: artifact.sha256,
			createdAt: artifact.createdAt.toISOString(),
		})),
	};
}

export async function buildPredictionsJsonlForRun(
	projectId: string,
	runId: string,
): Promise<string | null> {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(benchmarkRuns)
		.where(and(eq(benchmarkRuns.projectId, projectId), eq(benchmarkRuns.id, runId)))
		.limit(1);
	if (!run) return null;
	const rows = await database
		.select({
			instanceId: benchmarkRunInstances.instanceId,
			modelPatch: benchmarkRunInstances.modelPatch,
		})
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId))
		.orderBy(benchmarkRunInstances.createdAt);
	return buildPredictionsJsonl(
		rows.map((row) =>
			buildSwebenchPrediction({
				instanceId: row.instanceId,
				modelNameOrPath: run.modelNameOrPath,
				modelPatch: row.modelPatch,
			}),
		),
	);
}

export async function cancelBenchmarkRun(projectId: string, runId: string) {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(benchmarkRuns)
		.where(and(eq(benchmarkRuns.projectId, projectId), eq(benchmarkRuns.id, runId)))
		.limit(1);
	if (!run) return null;
	const reason = "benchmark run cancelled";
	if (run.status === "cancelled") {
		const now = new Date();
		await finalizeActiveBenchmarkRunInstances(runId, "cancelled", reason, now);
		const workflowsClosed = await finalizeBenchmarkWorkflowExecutions(
			runId,
			"cancelled",
			reason,
			now,
		);
		if (workflowsClosed) {
			await cleanupBenchmarkRunSandboxes(runId, reason);
			await releaseBenchmarkResourceLeasesForRun(runId, reason);
		} else {
			console.warn(
				`Benchmark run ${runId} cancellation left durable instances active; retaining sandboxes and leases`,
			);
		}
		await recomputeRunSummary(runId);
		return getBenchmarkRun(projectId, runId);
	}
	if (run.status === "completed" || run.status === "failed") {
		throw error(409, `Cannot cancel a ${run.status} benchmark run`);
	}
	const now = new Date();
	await database.transaction(async (tx) => {
		await tx
			.update(benchmarkRuns)
			.set({
				status: "cancelled",
				cancelRequestedAt: now,
				completedAt: now,
				updatedAt: now,
				summary: {
					...(isRecord(run.summary) ? run.summary : {}),
					cancelledAt: now.toISOString(),
				},
			})
			.where(eq(benchmarkRuns.id, runId));
	});
	await finalizeActiveBenchmarkRunInstances(runId, "cancelled", reason, now);
	const workflowsClosed = await finalizeBenchmarkWorkflowExecutions(
		runId,
		"cancelled",
		reason,
		now,
	);
	if (workflowsClosed) {
		await cleanupBenchmarkRunSandboxes(runId, reason);
		await releaseBenchmarkResourceLeasesForRun(runId, reason);
	} else {
		console.warn(
			`Benchmark run ${runId} cancellation left durable instances active; retaining sandboxes and leases`,
		);
	}
	await recomputeRunSummary(runId);
	return getBenchmarkRun(projectId, runId);
}

export async function markBenchmarkRunStatus(
	runId: string,
	status: BenchmarkRunStatus,
	extra: Record<string, unknown> = {},
) {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run) return null;
	if (run.status !== status && BENCHMARK_RUN_TERMINAL_STATUSES.has(run.status)) {
		return run;
	}
	if (run.status !== status && !canTransitionBenchmarkRun(run.status, status)) {
		throw new Error(`Invalid benchmark run transition ${run.status} -> ${status}`);
	}
	const now = new Date();
	let [updated] = await database
		.update(benchmarkRuns)
		.set(benchmarkRunStatusPatch(run, status, extra, now))
		.where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, run.status)))
		.returning();
	if (!updated) {
		const [current] = await database
			.select()
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, runId))
			.limit(1);
		if (!current) return null;
		if (current.status === status || BENCHMARK_RUN_TERMINAL_STATUSES.has(current.status)) {
			return current;
		}
		if (!canTransitionBenchmarkRun(current.status, status)) {
			throw new Error(
				`Invalid benchmark run transition after concurrent update ${current.status} -> ${status}`,
			);
		}
		[updated] = await database
			.update(benchmarkRuns)
			.set(benchmarkRunStatusPatch(current, status, extra, now))
			.where(and(eq(benchmarkRuns.id, runId), eq(benchmarkRuns.status, current.status)))
			.returning();
		if (!updated) {
			throw new Error(
				`Benchmark run ${runId} changed concurrently while marking ${status}; retry required`,
			);
		}
	}
	if (status === "failed" || status === "cancelled") {
		const reason = benchmarkRunTerminalReason(status, extra);
		await finalizeActiveBenchmarkRunInstances(runId, status, reason, now);
		const workflowsClosed = await finalizeBenchmarkWorkflowExecutions(
			runId,
			status,
			reason,
			now,
		);
		if (workflowsClosed) {
			await cleanupBenchmarkRunSandboxes(runId, reason);
			await releaseBenchmarkResourceLeasesForRun(runId, reason);
		} else {
			console.warn(
				`Benchmark run ${runId} terminal transition left durable instances active; retaining sandboxes and leases`,
			);
		}
		await recomputeRunSummary(runId);
	}
	if (status === "completed") {
		await releaseBenchmarkResourceLeasesForRun(runId, "benchmark run completed");
	}
	if (status === "evaluating") {
		await database
			.update(benchmarkRunInstances)
			.set({
				status: "evaluating",
				evaluationStatus: "evaluating",
				updatedAt: now,
			})
			.where(
				and(
					eq(benchmarkRunInstances.runId, runId),
					inArray(benchmarkRunInstances.status, [
						...ACTIVE_BENCHMARK_INSTANCE_STATUSES,
						"failed",
						"error",
						"timeout",
					] satisfies BenchmarkRunInstanceStatus[]),
				),
			);
	}
	if (updated) {
		await syncBenchmarkRunMlflow(runId, {
			terminate: status === "completed" || status === "failed" || status === "cancelled",
		});
		if (status === "completed" || status === "failed" || status === "cancelled") {
			await logBenchmarkTraceSummaryArtifact(runId);
		}
	}
	return updated ?? null;
}

function benchmarkRunStatusPatch(
	run: typeof benchmarkRuns.$inferSelect,
	status: BenchmarkRunStatus,
	extra: Record<string, unknown>,
	now: Date,
): Partial<typeof benchmarkRuns.$inferInsert> {
	const patch: Partial<typeof benchmarkRuns.$inferInsert> = {
		status,
		updatedAt: now,
		...extra,
	};
	if (status === "inferencing" && !run.startedAt) patch.startedAt = now;
	if (BENCHMARK_RUN_TERMINAL_STATUSES.has(status)) patch.completedAt = now;
	return patch;
}

export async function applyBenchmarkRunPreflight(params: {
	runId: string;
	inferenceEnvironmentsByInstanceId: Record<string, unknown>;
	preflightSummary?: Record<string, unknown> | null;
	capacitySnapshot?: Record<string, unknown> | null;
}) {
	const database = requireDb();
	const [run] = await database
		.select({
			id: benchmarkRuns.id,
			selectedInstanceIds: benchmarkRuns.selectedInstanceIds,
			summary: benchmarkRuns.summary,
		})
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, params.runId))
		.limit(1);
	if (!run) return null;

	const selectedInstanceIds = normalizeInstanceIds(run.selectedInstanceIds);
	const prepared = new Map<string, Record<string, unknown>>();
	for (const [instanceId, value] of Object.entries(
		params.inferenceEnvironmentsByInstanceId ?? {},
	)) {
		const environment = prevalidatedBenchmarkInferenceEnvironment(
			isRecord(value) ? value : null,
		);
		if (!environment) {
			throw error(
				400,
				`Preflight environment for ${instanceId} is missing a validated sandbox image`,
			);
		}
		prepared.set(instanceId, environment as unknown as Record<string, unknown>);
	}
	const missing = selectedInstanceIds.filter((instanceId) => !prepared.has(instanceId));
	if (missing.length > 0) {
		throw error(
			400,
			`Preflight results are missing ${missing.length} selected instance(s): ${missing.slice(0, 20).join(", ")}`,
		);
	}

	const existingSummary = isRecord(run.summary) ? run.summary : {};
	const mergedSummary: Record<string, unknown> = { ...existingSummary };
	if (isRecord(params.capacitySnapshot)) mergedSummary.capacity = params.capacitySnapshot;
	if (isRecord(params.preflightSummary)) mergedSummary.preflight = params.preflightSummary;

	await database.transaction(async (tx) => {
		for (const instanceId of selectedInstanceIds) {
			await tx
				.update(benchmarkRunInstances)
				.set({
					inferenceEnvironment: prepared.get(instanceId) ?? {},
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(benchmarkRunInstances.runId, params.runId),
						eq(benchmarkRunInstances.instanceId, instanceId),
					),
				);
		}
		await tx
			.update(benchmarkRuns)
			.set({
				summary: mergedSummary,
				updatedAt: new Date(),
			})
			.where(eq(benchmarkRuns.id, params.runId));
	});

	return {
		runId: params.runId,
		appliedInstances: selectedInstanceIds.length,
		summary: mergedSummary,
	};
}

function benchmarkRunTerminalReason(
	status: BenchmarkRunTerminalOutcome,
	extra: Record<string, unknown>,
): string {
	const error = typeof extra.error === "string" ? extra.error.trim() : "";
	if (error) return error;
	return status === "cancelled" ? "benchmark run cancelled" : "benchmark run failed";
}

function benchmarkRunInstanceTerminalReason(
	existingReason: string | null,
	terminalReason: string,
): string {
	if (!existingReason || existingReason === "end_turn") return terminalReason;
	return existingReason;
}

export function benchmarkRunInstanceTerminalPatch(
	row: BenchmarkRunInstanceTerminalInput,
	outcome: BenchmarkRunTerminalOutcome,
	reason: string,
	now = new Date(),
): Partial<typeof benchmarkRunInstances.$inferInsert> | null {
	if (INSTANCE_TERMINAL_STATUSES.has(row.status)) return null;
	const terminalReason =
		outcome === "cancelled" ? "benchmark_run_cancelled" : "benchmark_run_failed";
	const patch: Partial<typeof benchmarkRunInstances.$inferInsert> = {
		status: outcome === "cancelled" ? "cancelled" : "error",
		error: row.error ?? reason,
		terminationReason: benchmarkRunInstanceTerminalReason(
			row.terminationReason,
			terminalReason,
		),
		updatedAt: now,
	};
	if (
		row.inferenceStatus === "queued" ||
		row.inferenceStatus === "inferencing"
	) {
		patch.inferenceStatus = outcome === "cancelled" ? "cancelled" : "error";
		patch.inferenceError = row.inferenceError ?? reason;
		if (row.inferenceStatus === "inferencing") {
			patch.inferenceCompletedAt = row.inferenceCompletedAt ?? now;
		}
	}
	if (
		row.evaluationStatus === "pending" ||
		row.evaluationStatus === "evaluating"
	) {
		patch.evaluationStatus = outcome === "cancelled" ? "cancelled" : "error";
		patch.evaluationError = row.evaluationError ?? reason;
		if (row.evaluationStatus === "evaluating") {
			patch.evaluatedAt = row.evaluatedAt ?? now;
		}
	}
	return patch;
}

async function finalizeActiveBenchmarkRunInstances(
	runId: string,
	outcome: BenchmarkRunTerminalOutcome,
	reason: string,
	now = new Date(),
) {
	const database = requireDb();
	const rows = await database
		.select({
			id: benchmarkRunInstances.id,
			status: benchmarkRunInstances.status,
			inferenceStatus: benchmarkRunInstances.inferenceStatus,
			evaluationStatus: benchmarkRunInstances.evaluationStatus,
			error: benchmarkRunInstances.error,
			inferenceError: benchmarkRunInstances.inferenceError,
			evaluationError: benchmarkRunInstances.evaluationError,
			terminationReason: benchmarkRunInstances.terminationReason,
			inferenceCompletedAt: benchmarkRunInstances.inferenceCompletedAt,
			evaluatedAt: benchmarkRunInstances.evaluatedAt,
		})
		.from(benchmarkRunInstances)
		.where(
			and(
				eq(benchmarkRunInstances.runId, runId),
				inArray(benchmarkRunInstances.status, ACTIVE_BENCHMARK_INSTANCE_STATUSES),
			),
		);
	for (const row of rows) {
		const patch = benchmarkRunInstanceTerminalPatch(row, outcome, reason, now);
		if (!patch) continue;
		await database
			.update(benchmarkRunInstances)
			.set(patch)
			.where(eq(benchmarkRunInstances.id, row.id));
	}
}

async function finalizeBenchmarkWorkflowExecutions(
	runId: string,
	outcome: BenchmarkRunTerminalOutcome,
	reason: string,
	now = new Date(),
): Promise<boolean> {
	const database = requireDb();
	const rows = await database
		.select({
			runtimeAppId: benchmarkRuns.agentRuntimeAppId,
			runInstanceDaprId: benchmarkRunInstances.daprInstanceId,
			runInstanceSessionId: benchmarkRunInstances.sessionId,
			runInstanceTurnCount: benchmarkRunInstances.turnCount,
			sessionId: sessions.id,
			executionId: workflowExecutions.id,
			executionStatus: workflowExecutions.status,
			executionPhase: workflowExecutions.phase,
			executionDaprId: workflowExecutions.daprInstanceId,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.leftJoin(
			workflowExecutions,
			eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
		)
		.leftJoin(sessions, eq(sessions.workflowExecutionId, benchmarkRunInstances.workflowExecutionId))
		.where(eq(benchmarkRunInstances.runId, runId));
	const activeExecutionIds = new Set<string>();
	const daprInstanceIds = new Set<string>();
	const agentRuntimeCleanupRows: BenchmarkAgentRuntimeCleanupInput[] = [];
	const sessionIds = new Set<string>();
	for (const row of rows) {
		const hasActiveExecution =
			row.executionStatus === "pending" ||
			row.executionStatus === "running" ||
			row.executionPhase === "running";
		if (hasActiveExecution && row.executionId) {
			activeExecutionIds.add(row.executionId);
		}
		const daprInstanceId = row.executionDaprId ?? row.runInstanceDaprId;
		if (daprInstanceId) {
			daprInstanceIds.add(daprInstanceId);
		}
		const sessionId = row.runInstanceSessionId ?? row.sessionId;
		if (sessionId && row.runtimeAppId) {
			sessionIds.add(sessionId);
			agentRuntimeCleanupRows.push({
				runtimeAppId: row.runtimeAppId,
				sessionId,
				turnCount: row.runInstanceTurnCount,
			});
		}
	}
	const turnsBySession = new Map<string, BenchmarkSessionTurnInput[]>();
	if (sessionIds.size > 0) {
		const turnRows = await database
			.select({
				sessionId: sessionEvents.sessionId,
				data: sessionEvents.data,
				sequence: sessionEvents.sequence,
			})
			.from(sessionEvents)
			.where(
				and(
					inArray(sessionEvents.sessionId, [...sessionIds]),
					eq(sessionEvents.type, "session.turn_started"),
				),
			)
			.orderBy(asc(sessionEvents.sequence));
		for (const turnRow of turnRows) {
			const data =
				turnRow.data && typeof turnRow.data === "object" && !Array.isArray(turnRow.data)
					? (turnRow.data as Record<string, unknown>)
					: {};
			const childInstanceId =
				typeof data.childInstanceId === "string"
					? data.childInstanceId
					: typeof data.child_instance_id === "string"
						? data.child_instance_id
						: null;
			const rawTurn = Number(data.turn);
			const turns = turnsBySession.get(turnRow.sessionId) ?? [];
			turns.push({
				sessionId: turnRow.sessionId,
				childInstanceId,
				turn: Number.isFinite(rawTurn) ? rawTurn : null,
			});
			turnsBySession.set(turnRow.sessionId, turns);
		}
	}
	let allDurableInstancesClosed = true;
	const agentRuntimeInstances = new Map<string, Set<string>>();
	for (const cleanupRow of agentRuntimeCleanupRows) {
		const runtimeAppId = cleanupRow.runtimeAppId;
		if (!runtimeAppId) continue;
		const instances = agentRuntimeInstances.get(runtimeAppId) ?? new Set<string>();
		for (const instanceId of benchmarkAgentRuntimeCleanupInstanceIds(
			cleanupRow,
			cleanupRow.sessionId
				? turnsBySession.get(cleanupRow.sessionId)
				: null,
		)) {
			instances.add(instanceId);
		}
		agentRuntimeInstances.set(runtimeAppId, instances);
	}
	await runWithConcurrency(
		[...agentRuntimeInstances.entries()].flatMap(([runtimeAppId, instanceIds]) =>
			[...instanceIds].map((instanceId) => ({ runtimeAppId, instanceId })),
		),
		BENCHMARK_TERMINATION_CONCURRENCY,
		async ({ runtimeAppId, instanceId }) => {
			const closed = await terminateAndPurgeBenchmarkAgentRuntimeInstance(
				runtimeAppId,
				instanceId,
				reason,
			);
			if (!closed) allDurableInstancesClosed = false;
		},
	);
	await runWithConcurrency(
		[...daprInstanceIds],
		BENCHMARK_TERMINATION_CONCURRENCY,
		async (instanceId) => {
			const closed = await terminateAndPurgeBenchmarkWorkflowInstance(
				instanceId,
				reason,
			);
			if (!closed) allDurableInstancesClosed = false;
		},
	);
	if (!allDurableInstancesClosed) {
		console.warn(
			`Benchmark run ${runId} durable cleanup did not confirm every workflow closed; leaving session/execution rows active for retry`,
		);
		return false;
	}
	if (sessionIds.size > 0) {
		await database
			.update(sessions)
			.set({
				status: "terminated",
				updatedAt: now,
			})
			.where(
				and(
					inArray(sessions.id, [...sessionIds]),
					inArray(sessions.status, ["pending", "running", "rescheduling"]),
				),
			);
	}
	if (activeExecutionIds.size === 0) return true;
	await database
		.update(workflowExecutions)
		.set({
			status: outcome === "cancelled" ? "cancelled" : "error",
			phase: outcome === "cancelled" ? "cancelled" : "failed",
			error: reason,
			completedAt: now,
		})
		.where(inArray(workflowExecutions.id, [...activeExecutionIds]));
	return true;
}

async function terminateAndPurgeBenchmarkWorkflowInstance(
	instanceId: string,
	reason: string,
): Promise<boolean> {
	const termination = await terminateBenchmarkWorkflowInstance(instanceId, reason);
	const closed =
		termination === "alreadyGone" ||
		(await waitForBenchmarkWorkflowInstanceClosed(instanceId));
	const effectiveTermination =
		termination === "alreadyGone"
			? termination
			: closed
				? "terminated"
				: termination;
	if (closed) {
		await purgeBenchmarkWorkflowInstance(instanceId, effectiveTermination);
	}
	return closed;
}

type DurableTerminationResult = "terminated" | "alreadyGone" | "failed";

async function terminateBenchmarkWorkflowInstance(
	instanceId: string,
	reason: string,
): Promise<DurableTerminationResult> {
	try {
		const res = await daprFetch(
			`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}/terminate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason }),
				maxRetries: 0,
				signal: AbortSignal.timeout(BENCHMARK_TERMINATION_REQUEST_TIMEOUT_MS),
			},
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			if (res.status === 404 || isBenignDaprTerminationMiss(detail)) {
				return "alreadyGone";
			}
			console.warn(
				`Failed to terminate benchmark workflow ${instanceId}: ${res.status} ${detail}`,
			);
			return "failed";
		}
		return "terminated";
	} catch (err) {
		if (isBenignDaprTerminationMiss(err)) return "alreadyGone";
		console.warn(
			`Failed to terminate benchmark workflow ${instanceId}:`,
			err instanceof Error ? err.message : err,
		);
		return "failed";
	}
}

async function waitForBenchmarkWorkflowInstanceClosed(
	instanceId: string,
): Promise<boolean> {
	return waitForDurableRuntimeClosed(
		`benchmark workflow ${instanceId}`,
		async () => {
			const res = await daprFetch(
				`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}/status`,
				{
					method: "GET",
					signal: AbortSignal.timeout(5_000),
					maxRetries: 0,
				},
			);
			if (res.status === 404) return DURABLE_RUNTIME_MISSING_STATUS;
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (isBenignDaprTerminationMiss(detail)) {
					return DURABLE_RUNTIME_MISSING_STATUS;
				}
				throw new Error(
					`status request failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			const body = await res.json().catch(() => null);
			return durableRuntimeStatusFromBody(body);
		},
	);
}

async function purgeBenchmarkWorkflowInstance(
	instanceId: string,
	termination: DurableTerminationResult,
) {
	const purgeUrl = (force: boolean) =>
		`${getOrchestratorUrl()}/api/v2/workflows/${encodeURIComponent(instanceId)}?force=${force ? "true" : "false"}&recursive=true`;
	try {
		const res = await daprFetch(
			purgeUrl(false),
			{
				method: "DELETE",
				signal: AbortSignal.timeout(BENCHMARK_TERMINATION_REQUEST_TIMEOUT_MS),
				maxRetries: 0,
			},
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return;
			if (termination === "terminated" || termination === "alreadyGone") {
				const forceRes = await daprFetch(purgeUrl(true), {
					method: "DELETE",
					signal: AbortSignal.timeout(BENCHMARK_TERMINATION_REQUEST_TIMEOUT_MS),
					maxRetries: 0,
				});
				if (forceRes.ok) return;
				const forceDetail = await forceRes.text().catch(() => "");
				if (
					forceRes.status === 404 ||
					isBenignDaprTerminationMiss(forceDetail)
				) {
					return;
				}
				console.warn(
					`Failed to purge benchmark workflow ${instanceId}: ${forceRes.status} ${forceDetail}`,
				);
				return;
			}
			console.warn(
				`Failed to purge benchmark workflow ${instanceId}: ${res.status} ${detail}`,
			);
		}
	} catch (err) {
		if (isBenignDaprTerminationMiss(err)) return;
		console.warn(
			`Failed to purge benchmark workflow ${instanceId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

async function terminateAndPurgeBenchmarkAgentRuntimeInstance(
	runtimeAppId: string,
	instanceId: string,
	reason: string,
): Promise<boolean> {
	const termination = await terminateBenchmarkAgentRuntimeInstance(
		runtimeAppId,
		instanceId,
		reason,
	);
	const closed =
		termination === "alreadyGone" ||
		(await waitForBenchmarkAgentRuntimeInstanceClosed(runtimeAppId, instanceId));
	const effectiveTermination =
		termination === "alreadyGone"
			? termination
			: closed
				? "terminated"
				: termination;
	if (closed) {
		await purgeBenchmarkAgentRuntimeInstance(
			runtimeAppId,
			instanceId,
			effectiveTermination,
		);
	}
	return closed;
}

async function terminateBenchmarkAgentRuntimeInstance(
	runtimeAppId: string,
	instanceId: string,
	reason: string,
): Promise<DurableTerminationResult> {
	try {
		const res = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(instanceId)}/terminate`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ reason }),
				signal: AbortSignal.timeout(BENCHMARK_TERMINATION_REQUEST_TIMEOUT_MS),
				maxRetries: 0,
			},
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			if (res.status === 404 || isBenignDaprTerminationMiss(detail)) {
				return "alreadyGone";
			}
			console.warn(
				`Failed to terminate benchmark agent runtime ${runtimeAppId}/${instanceId}: ${res.status} ${detail}`,
			);
			return "failed";
		}
		return "terminated";
	} catch (err) {
		if (isBenignDaprTerminationMiss(err)) return "alreadyGone";
		console.warn(
			`Failed to terminate benchmark agent runtime ${runtimeAppId}/${instanceId}:`,
			err,
		);
		return "failed";
	}
}

async function waitForBenchmarkAgentRuntimeInstanceClosed(
	runtimeAppId: string,
	instanceId: string,
): Promise<boolean> {
	return waitForDurableRuntimeClosed(
		`benchmark agent runtime ${runtimeAppId}/${instanceId}`,
		async () => {
			const res = await daprFetch(
				`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(instanceId)}/status`,
				{
					method: "GET",
					signal: AbortSignal.timeout(5_000),
					maxRetries: 0,
				},
			);
			if (res.status === 404) return DURABLE_RUNTIME_MISSING_STATUS;
			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				if (isBenignDaprTerminationMiss(detail)) {
					return DURABLE_RUNTIME_MISSING_STATUS;
				}
				throw new Error(
					`status request failed with ${res.status}${detail ? `: ${detail}` : ""}`,
				);
			}
			const body = await res.json().catch(() => null);
			return durableRuntimeStatusFromBody(body);
		},
	);
}

async function purgeBenchmarkAgentRuntimeInstance(
	runtimeAppId: string,
	instanceId: string,
	termination: DurableTerminationResult,
) {
	const purgeUrl = (force: boolean) =>
		`${getDaprSidecarUrl()}/v1.0/invoke/${encodeURIComponent(runtimeAppId)}/method/api/v2/agent-runs/${encodeURIComponent(instanceId)}?force=${force ? "true" : "false"}&recursive=true`;
	try {
		const res = await daprFetch(
			purgeUrl(false),
			{
				method: "DELETE",
				signal: AbortSignal.timeout(BENCHMARK_TERMINATION_REQUEST_TIMEOUT_MS),
				maxRetries: 0,
			},
		);
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			if (res.status === 404 || isBenignDaprTerminationMiss(detail)) return;
			if (termination === "terminated" || termination === "alreadyGone") {
				const forceRes = await daprFetch(purgeUrl(true), {
					method: "DELETE",
					signal: AbortSignal.timeout(BENCHMARK_TERMINATION_REQUEST_TIMEOUT_MS),
					maxRetries: 0,
				});
				if (forceRes.ok) return;
				const forceDetail = await forceRes.text().catch(() => "");
				if (
					forceRes.status === 404 ||
					isBenignDaprTerminationMiss(forceDetail)
				) {
					return;
				}
				console.warn(
					`Failed to purge benchmark agent runtime ${runtimeAppId}/${instanceId}: ${forceRes.status} ${forceDetail}`,
				);
				return;
			}
			console.warn(
				`Failed to purge benchmark agent runtime ${runtimeAppId}/${instanceId}: ${res.status} ${detail}`,
			);
		}
	} catch (err) {
		if (isBenignDaprTerminationMiss(err)) return;
		console.warn(
			`Failed to purge benchmark agent runtime ${runtimeAppId}/${instanceId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

type BenchmarkSandboxCleanupResult = {
	reason: string;
	retainRequested: boolean;
	attempted: string[];
	deleted: string[];
	notFound: string[];
	skipped: string[];
	errors: Array<{ sandboxName: string; status?: number; error: string }>;
};

export const __benchmarkSandboxCleanupForTest = {
	collectBenchmarkSandboxNamesFromValues,
	isOpenShellSandboxNotFound,
	shouldDeleteBenchmarkSandboxName,
};

async function cleanupBenchmarkRunSandboxes(runId: string, reason: string) {
	const retainRequested = shouldKeepSwebenchSandboxAfterRun();
	const cleanup: BenchmarkSandboxCleanupResult = {
		reason,
		retainRequested,
		attempted: [],
		deleted: [],
		notFound: [],
		skipped: [],
		errors: [],
	};
	const sandboxNames = await loadBenchmarkRunSandboxNames(runId);
	if (retainRequested) {
		cleanup.skipped = sandboxNames;
		await recordBenchmarkSandboxCleanup(runId, cleanup);
		return cleanup;
	}
	const candidates = sandboxNames.filter((sandboxName) =>
		shouldDeleteBenchmarkSandboxName(runId, sandboxName),
	);
	const skipped = sandboxNames.filter(
		(sandboxName) => !shouldDeleteBenchmarkSandboxName(runId, sandboxName),
	);
	cleanup.skipped = skipped;
	cleanup.attempted = candidates;
	await runWithConcurrency(
		candidates,
		BENCHMARK_SANDBOX_CLEANUP_CONCURRENCY,
		async (sandboxName) => {
			await deleteOpenShellSandboxForBenchmark(sandboxName, cleanup);
		},
	);
	await recordBenchmarkSandboxCleanup(runId, cleanup);
	return cleanup;
}

async function loadBenchmarkRunSandboxNames(runId: string): Promise<string[]> {
	const database = requireDb();
	const instanceRows = await database
		.select({
			instanceId: benchmarkRunInstances.instanceId,
			sandboxName: benchmarkRunInstances.sandboxName,
			workspaceRef: benchmarkRunInstances.workspaceRef,
			sessionId: benchmarkRunInstances.sessionId,
			workflowExecutionId: benchmarkRunInstances.workflowExecutionId,
			executionOutput: workflowExecutions.output,
		})
		.from(benchmarkRunInstances)
		.leftJoin(
			workflowExecutions,
			eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
		)
		.where(eq(benchmarkRunInstances.runId, runId));

	const values: unknown[] = [];
	const sessionIds = new Set<string>();
	const executionIds = new Set<string>();
	for (const row of instanceRows) {
		values.push({
			sandboxName: row.sandboxName,
			workspaceRef: row.workspaceRef,
		});
		values.push(row.executionOutput);
		if (
			row.sandboxName ||
			row.workspaceRef ||
			row.sessionId ||
			row.workflowExecutionId ||
			row.executionOutput
		) {
			values.push({
				workspaceRef: buildStableWorkspaceRef("swebench", [
					runId,
					row.instanceId,
				]),
			});
		}
		if (row.sessionId) sessionIds.add(row.sessionId);
		if (row.workflowExecutionId) executionIds.add(row.workflowExecutionId);
	}

	const sessionPredicates: SQL[] = [];
	if (sessionIds.size > 0) {
		sessionPredicates.push(inArray(sessions.id, [...sessionIds]));
	}
	if (executionIds.size > 0) {
		sessionPredicates.push(
			inArray(sessions.workflowExecutionId, [...executionIds]),
		);
	}
	if (sessionPredicates.length > 0) {
		const sessionRows = await database
			.select({
				sandboxName: sessions.sandboxName,
				workspaceSandboxName: sessions.workspaceSandboxName,
			})
			.from(sessions)
			.where(
				sessionPredicates.length === 1
					? sessionPredicates[0]
					: or(...sessionPredicates),
			);
		for (const row of sessionRows) {
			values.push({
				sandboxName: row.sandboxName,
				workspaceSandboxName: row.workspaceSandboxName,
			});
		}
	}

	if (executionIds.size > 0) {
		const logRows = await database
			.select({
				nodeId: workflowExecutionLogs.nodeId,
				activityName: workflowExecutionLogs.activityName,
				input: workflowExecutionLogs.input,
				output: workflowExecutionLogs.output,
			})
			.from(workflowExecutionLogs)
			.where(
				and(
					inArray(workflowExecutionLogs.executionId, [...executionIds]),
					inArray(workflowExecutionLogs.nodeId, [
						"workspace_profile",
						"solve",
						"cleanup_workspace",
					]),
				),
			);
		for (const row of logRows) {
			values.push({
				nodeId: row.nodeId,
				activityName: row.activityName,
				input: row.input,
				output: row.output,
			});
		}
	}

	return collectBenchmarkSandboxNamesFromValues(values);
}

function collectBenchmarkSandboxNamesFromValues(values: unknown[]): string[] {
	const names = new Set<string>();
	for (const value of values) {
		for (const candidate of collectStringsByKey(value, [
			"sandboxName",
			"sandbox_name",
			"workspaceSandboxName",
			"workspace_sandbox_name",
			"workspaceRef",
			"workspace_ref",
		])) {
			const normalized = candidate.trim();
			if (normalized) names.add(normalized);
		}
	}
	return [...names];
}

function shouldDeleteBenchmarkSandboxName(runId: string, sandboxName: string): boolean {
	const name = sandboxName.trim();
	if (!name) return false;
	if (isAgentRuntimeSandboxName(name)) return false;
	if (name.startsWith("agent-runtime-")) return false;
	const normalizedName = normalizeSandboxNamePart(name);
	const normalizedRunId = normalizeSandboxNamePart(runId);
	if (!normalizedName) return false;
	return (
		normalizedName.startsWith("swebench-") ||
		(Boolean(normalizedRunId) && normalizedName.includes(normalizedRunId))
	);
}

function normalizeSandboxNamePart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

async function deleteOpenShellSandboxForBenchmark(
	sandboxName: string,
	cleanup: BenchmarkSandboxCleanupResult,
) {
	try {
		const res = await openshellRuntimeFetch(
			`/api/v1/sandboxes/${encodeURIComponent(sandboxName)}`,
			{
				method: "DELETE",
				signal: AbortSignal.timeout(10_000),
			},
		);
		if (res.ok) {
			cleanup.deleted.push(sandboxName);
			return;
		}
		const detail = await res.text().catch(() => "");
		if (res.status === 404 || isOpenShellSandboxNotFound(detail)) {
			cleanup.notFound.push(sandboxName);
			return;
		}
		cleanup.errors.push({
			sandboxName,
			status: res.status,
			error: detail.slice(0, 500) || res.statusText || "delete failed",
		});
	} catch (err) {
		cleanup.errors.push({
			sandboxName,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function isOpenShellSandboxNotFound(detail: string): boolean {
	const normalized = detail.toLowerCase();
	return (
		normalized.includes("sandbox not found") ||
		normalized.includes("status: notfound")
	);
}

async function recordBenchmarkSandboxCleanup(
	runId: string,
	cleanup: BenchmarkSandboxCleanupResult,
) {
	const database = requireDb();
	const [run] = await database
		.select({ summary: benchmarkRuns.summary })
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	const summary = isRecord(run?.summary) ? run.summary : {};
	await database
		.update(benchmarkRuns)
		.set({
			summary: {
				...summary,
				sandboxCleanup: {
					reason: cleanup.reason,
					retainRequested: cleanup.retainRequested,
					attempted: cleanup.attempted.length,
					deleted: cleanup.deleted.length,
					notFound: cleanup.notFound.length,
					skipped: cleanup.skipped.length,
					errors: cleanup.errors,
					sandboxNames: cleanup.attempted,
					cleanedAt: new Date().toISOString(),
				},
			},
			updatedAt: new Date(),
		})
		.where(eq(benchmarkRuns.id, runId));
}

export async function recomputeRunSummary(runId: string) {
	const database = requireDb();
	const [run, rows] = await Promise.all([
		database
			.select({ summary: benchmarkRuns.summary, status: benchmarkRuns.status })
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, runId))
			.limit(1),
		database
			.select({
				id: benchmarkRunInstances.id,
				status: benchmarkRunInstances.status,
				inferenceStatus: benchmarkRunInstances.inferenceStatus,
				usage: benchmarkRunInstances.usage,
				sessionId: benchmarkRunInstances.sessionId,
			})
			.from(benchmarkRunInstances)
			.where(eq(benchmarkRunInstances.runId, runId)),
	]);
	const existingSummary = isRecord(run[0]?.summary) ? run[0].summary : {};
	const zeroedStatusBuckets = Object.fromEntries(
		BENCHMARK_RUN_SUMMARY_STATUS_KEYS.map((status) => [status, 0]),
	);
	const summary = {
		...existingSummary,
		...zeroedStatusBuckets,
		...summarizeRunInstances(rows.map((row) => row.status)),
	};
	await database
		.update(benchmarkRuns)
		.set({ summary, updatedAt: new Date() })
		.where(eq(benchmarkRuns.id, runId));

	// Phase A + B backstop: re-aggregate from session_events for each instance
	// so rows reflect canonical counts even if the in-line triggers (Phase A's
	// agent.llm_usage hook, Phase B's session.status_terminated hook) raced
	// with row creation OR with concurrent transactions. By the time
	// recomputeRunSummary is called (from the evaluation-results endpoint),
	// all events are durably committed and the row's session_id is populated.
	for (const row of rows) {
		if (row.sessionId) {
			await aggregateLlmUsageFromSessionEvents(row.sessionId);
			await aggregateBenchmarkLifecycleFromSessionEvents(row.sessionId, {
				finalize: shouldFinalizeBenchmarkLifecycle(row),
			});
		}
		await aggregateBenchmarkInstanceTimings(row.id);
	}

	// Re-fetch usage AFTER the Phase A backfill so refreshInstanceCost sees
	// the populated tokens.
	const refreshedRows = await database
		.select({
			id: benchmarkRunInstances.id,
			usage: benchmarkRunInstances.usage,
		})
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId));

	// Refresh per-instance cost_usd from accumulated tokens via the central
	// pricing table. The events.ts hook keeps token deltas in `usage` but
	// doesn't compute cost on every event (avoids loading the pricing module
	// on the hot path). Cost is recomputed at every recompute boundary.
	for (const row of refreshedRows) {
		await refreshInstanceCost(row.id, row.usage as Record<string, unknown> | null);
	}

	// Phase G — run scorers (deterministic + LLM-judge) on every instance
	// in the run. Idempotent: skips per (run_instance_id, scorer_name,
	// scorer_version) so re-running recompute doesn't double-score.
	// Wrapped in try/catch so a scorer outage doesn't break the recompute path.
	try {
		await runScorersForRun(runId);
	} catch (err) {
		console.warn(
			`[bench-scorer] runScorersForRun(${runId}) failed:`,
			(err as Error)?.message ?? err,
		);
	}

	await syncBenchmarkRunMlflow(runId);
	if (run[0]?.status && BENCHMARK_RUN_TERMINAL_STATUSES.has(run[0].status)) {
		await logBenchmarkTraceSummaryArtifact(runId);
	}

	return summary;
}

async function refreshInstanceCost(
	instanceRowId: string,
	usage: Record<string, unknown> | null,
): Promise<void> {
	if (!usage) return;
	const totals: UsageTotals = {
		inputTokens: Number(usage.input_tokens ?? 0) || 0,
		outputTokens: Number(usage.output_tokens ?? 0) || 0,
		cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0) || 0,
		cacheCreateTokens: Number(usage.cache_creation_input_tokens ?? 0) || 0,
	};
	const totalTokens =
		totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheCreateTokens;
	if (totalTokens <= 0) return;
	const model = typeof usage.model === "string" ? usage.model : null;
	const newCost = costFor(model, totals);
	const currentCost = Number(usage.cost_usd ?? 0);
	// Skip the UPDATE when cost is already accurate (e.g. nothing changed
	// since the last recompute). Floating-point compare with a tight epsilon.
	if (Math.abs(currentCost - newCost) < 0.000001) return;
	const database = requireDb();
	const nextUsage = { ...usage, cost_usd: newCost };
	await database
		.update(benchmarkRunInstances)
		.set({ usage: nextUsage, updatedAt: new Date() })
		.where(eq(benchmarkRunInstances.id, instanceRowId));
}

export function getSwebenchCoordinatorUrl(): string {
	return (
		env.SWEBENCH_COORDINATOR_URL ||
		"http://swebench-coordinator.workflow-builder.svc.cluster.local:8080"
	);
}

export async function startSwebenchCoordinator(runId: string) {
	const internalToken = env.INTERNAL_API_TOKEN;
	if (!internalToken) {
		throw new Error("INTERNAL_API_TOKEN is required to start SWE-bench coordinator");
	}
	const res = await daprFetch(`${getSwebenchCoordinatorUrl()}/api/v1/benchmark-runs`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Internal-Token": internalToken,
		},
		body: JSON.stringify({ runId }),
		maxRetries: 0,
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(
			typeof body.error === "string"
				? body.error
				: typeof body.detail === "string"
					? body.detail
				: `SWE-bench coordinator returned ${res.status}`,
		);
	}
	return body;
}

export async function startBenchmarkInstanceWorkflow(params: {
	runId: string;
	instanceId: string;
}) {
	const database = requireDb();
	const [row] = await database
		.select({
			run: benchmarkRuns,
			suite: benchmarkSuites,
			runInstance: benchmarkRunInstances,
			instance: benchmarkInstances,
			agent: agents,
		})
		.from(benchmarkRunInstances)
		.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.leftJoin(
			benchmarkInstances,
			eq(benchmarkInstances.id, benchmarkRunInstances.benchmarkInstanceId),
		)
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(
			and(
				eq(benchmarkRunInstances.runId, params.runId),
				eq(benchmarkRunInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!row) throw error(404, "Benchmark instance not found");
	if (!row.instance?.repo || !row.instance.baseCommit || !row.instance.problemStatement) {
		throw error(
			409,
			`SWE-bench metadata for ${params.instanceId} has not been imported yet`,
		);
	}
	if (row.run.status !== "queued" && row.run.status !== "inferencing") {
		return {
			executionId: row.runInstance.workflowExecutionId,
			daprInstanceId: row.runInstance.daprInstanceId,
			skipped: true,
			reason: `benchmark_run_${row.run.status}`,
		};
	}
	if (
		row.runInstance.status !== "queued" ||
		row.runInstance.inferenceStatus !== "queued"
	) {
		return {
			executionId: row.runInstance.workflowExecutionId,
			daprInstanceId: row.runInstance.daprInstanceId,
			skipped: true,
			reason: `benchmark_instance_${row.runInstance.status}`,
		};
	}
	await ensureBenchmarkInstanceMlflowRun(params);

	const workflow = await ensureHiddenBenchmarkWorkflow({
		projectId: row.run.projectId,
		userId: row.run.userId,
	});
	const inferenceEnvironment = requireValidatedBenchmarkInferenceEnvironment(
		row.runInstance.inferenceEnvironment,
		row.runInstance.instanceId,
	);
	const rawSpec = buildSwebenchInstanceWorkflowSpec({
		runId: row.run.id,
		suiteSlug: row.suite.slug as SwebenchSuiteSlug,
		datasetName: row.suite.datasetName,
		instanceId: row.runInstance.instanceId,
		repo: row.instance.repo,
		baseCommit: row.instance.baseCommit,
		problemStatement: row.instance.problemStatement,
		hintsText: row.instance.hintsText,
		testMetadata: row.instance.testMetadata,
		agentId: row.run.agentId,
		agentVersion: row.run.agentVersion,
		timeoutSeconds: row.run.timeoutSeconds,
		maxTurns: row.run.maxTurns,
		inferenceEnvironment,
	});
	const spec = await resolveSpecAgentRefs(rawSpec);
	const triggerData = {
		runId: row.run.id,
		instanceId: row.runInstance.instanceId,
		inferenceEnvironment,
	};

	const [execution] = await database
		.insert(workflowExecutions)
		.values({
			workflowId: workflow.id,
			userId: row.run.userId,
			projectId: row.run.projectId,
			status: "running",
			phase: "running",
			progress: 0,
			input: triggerData,
			executionIrVersion: "sw-1.0",
			executionIr: { spec, triggerData, benchmarkRunId: row.run.id },
		})
		.returning({ id: workflowExecutions.id });

	const res = await daprFetch(`${getOrchestratorUrl()}/api/v2/sw-workflows`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			workflow: spec,
			workflowId: workflow.id,
			triggerData,
			dbExecutionId: execution.id,
		}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		await database
			.update(workflowExecutions)
			.set({
				status: "error",
				phase: "failed",
				error: detail.slice(0, 1000),
				completedAt: new Date(),
			})
			.where(eq(workflowExecutions.id, execution.id));
		throw error(res.status, detail || "Failed to start benchmark instance workflow");
	}
	const result = (await res.json()) as { instanceId?: string };
	const daprInstanceId = result.instanceId ?? null;
	await database
		.update(workflowExecutions)
		.set({
			daprInstanceId,
			workflowSessionId: execution.id,
		})
		.where(eq(workflowExecutions.id, execution.id));
	const [updatedRunInstance] = await database
		.update(benchmarkRunInstances)
		.set({
			status: "inferencing",
			inferenceStatus: "inferencing",
			inferenceEnvironment: inferenceEnvironment as unknown as Record<string, unknown>,
			workflowExecutionId: execution.id,
			daprInstanceId,
			startedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(benchmarkRunInstances.id, row.runInstance.id),
				eq(benchmarkRunInstances.status, "queued"),
				eq(benchmarkRunInstances.inferenceStatus, "queued"),
				sql`EXISTS (
					SELECT 1 FROM benchmark_runs
					WHERE benchmark_runs.id = ${row.run.id}
						AND benchmark_runs.status IN ('queued', 'inferencing')
				)`,
			),
		)
		.returning({ id: benchmarkRunInstances.id });
	if (!updatedRunInstance) {
		if (daprInstanceId) {
			await terminateAndPurgeBenchmarkWorkflowInstance(
				daprInstanceId,
				"benchmark instance start superseded",
			);
		}
		await database
			.update(workflowExecutions)
			.set({
				status: "cancelled",
				phase: "cancelled",
				error: "benchmark instance start superseded",
				completedAt: new Date(),
			})
			.where(eq(workflowExecutions.id, execution.id));
		return {
			executionId: execution.id,
			daprInstanceId,
			skipped: true,
			reason: "benchmark_instance_start_superseded",
		};
	}
	return { executionId: execution.id, daprInstanceId };
}

export async function syncBenchmarkInstanceFromExecution(params: {
	runId: string;
	instanceId: string;
}) {
	const database = requireDb();
	const [row] = await database
		.select({
			runInstance: benchmarkRunInstances,
			run: benchmarkRuns,
			execution: workflowExecutions,
		})
		.from(benchmarkRunInstances)
		.leftJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
		.leftJoin(
			workflowExecutions,
			eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
		)
		.where(
			and(
				eq(benchmarkRunInstances.runId, params.runId),
				eq(benchmarkRunInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!row) return null;
	if (!row.execution) return row.runInstance;

	let runtimeStatus: string | null = null;
	let runtimeOutput: unknown = row.execution.output;
	if (row.execution.daprInstanceId) {
		const res = await daprFetch(
			`${getOrchestratorUrl()}/api/v2/workflows/${row.execution.daprInstanceId}/status`,
			{ maxRetries: 1 },
		).catch(() => null);
		if (res?.ok) {
			const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
			runtimeStatus = typeof body.runtimeStatus === "string" ? body.runtimeStatus : null;
			runtimeOutput = body.output ?? body.outputs ?? runtimeOutput;
		}
	}

	const executionFailed = isFailedWorkflowExecution(row.execution);
	const status = executionFailed
		? "error"
		: mapExecutionStatus(row.execution.status, runtimeStatus);
	if (status === "running" || status === "pending") {
		return (
			(await timeoutBenchmarkInstanceIfStalled(row.runInstance)) ??
			row.runInstance
		);
	}

	const patch = extractModelPatch(runtimeOutput ?? row.execution.output);
	const now = new Date();
	const successfulEmptyPatchReason =
		status === "success" && !patch.trim()
			? extractAgentStopReason(runtimeOutput ?? row.execution.output, row.run?.maxTurns)
			: null;
	const inferenceError =
		status === "success"
			? successfulEmptyPatchReason
			: workflowExecutionError(row.execution, runtimeOutput);
	const nextVisibleStatus = resolveBenchmarkInstanceStatusAfterInference(
		row.runInstance.status,
		status,
	);
	const keepEvaluationOwnedError =
		row.runInstance.status === "evaluating" ||
		INSTANCE_TERMINAL_STATUSES.has(row.runInstance.status);
	const sessionRow = row.runInstance.workflowExecutionId
		? await database
				.select({
					id: sessions.id,
					sandboxName: sessions.sandboxName,
					workspaceSandboxName: sessions.workspaceSandboxName,
				})
				.from(sessions)
				.where(eq(sessions.workflowExecutionId, row.runInstance.workflowExecutionId))
				.limit(1)
		: [];
	const sessionEventRows = sessionRow[0]?.id
		? await database
				.select({ data: sessionEvents.data })
				.from(sessionEvents)
				.where(eq(sessionEvents.sessionId, sessionRow[0].id))
				.orderBy(asc(sessionEvents.sequence))
		: [];
	const runtimeLinks = extractBenchmarkRuntimeLinks({
		currentSandboxName: row.runInstance.sandboxName,
		currentWorkspaceRef: row.runInstance.workspaceRef,
		currentTraceIds: row.runInstance.traceIds,
		sessionSandboxName: sessionRow[0]?.sandboxName,
		sessionWorkspaceSandboxName: sessionRow[0]?.workspaceSandboxName,
		values: [
			{ primaryTraceId: row.execution.primaryTraceId },
			row.execution.output,
			runtimeOutput,
			...sessionEventRows.map((event) => event.data),
		],
	});
	const runtimeInferenceEnvironment = extractInferenceEnvironment(
		runtimeOutput ?? row.execution.output,
	);
	const update: Partial<typeof benchmarkRunInstances.$inferInsert> = {
		status: nextVisibleStatus,
		inferenceStatus: resolveBenchmarkInferenceStatus(status),
		modelPatch: status === "success" ? patch : row.runInstance.modelPatch,
		patchBytes: status === "success" ? Buffer.byteLength(patch, "utf8") : undefined,
		patchSha256: status === "success" ? sha256(patch) : undefined,
		error: keepEvaluationOwnedError ? row.runInstance.error : inferenceError,
		inferenceError,
		inferenceCompletedAt: now,
		sessionId: sessionRow[0]?.id ?? row.runInstance.sessionId,
		sandboxName: runtimeLinks.sandboxName,
		workspaceRef: runtimeLinks.workspaceRef,
		traceIds: runtimeLinks.traceIds,
		inferenceEnvironment:
			runtimeInferenceEnvironment ?? row.runInstance.inferenceEnvironment,
		updatedAt: now,
	};
	if (!row.execution.primaryTraceId && runtimeLinks.traceIds[0]) {
		await database
			.update(workflowExecutions)
			.set({ primaryTraceId: runtimeLinks.traceIds[0] })
			.where(eq(workflowExecutions.id, row.execution.id));
	}
	const [updated] = await database
		.update(benchmarkRunInstances)
		.set(update)
		.where(eq(benchmarkRunInstances.id, row.runInstance.id))
		.returning();
	if (updated) {
		await aggregateBenchmarkInstanceTimings(updated.id);
	}
	await recomputeRunSummary(params.runId);
	if (updated) {
		await syncBenchmarkInstanceMlflowAndTraceBundle({
			runId: params.runId,
			instanceId: params.instanceId,
		});
	}
	return updated ?? null;
}

function benchmarkInferenceStallSeconds(): number {
	return clampInteger(
		env.BENCHMARK_INFERENCE_STALL_SECONDS,
		60,
		24 * 60 * 60,
		480,
	);
}

function shouldKeepSwebenchSandboxAfterRun(): boolean {
	return parseBooleanFlag(
		env.SWEBENCH_KEEP_SANDBOX_AFTER_RUN ??
			process.env.SWEBENCH_KEEP_SANDBOX_AFTER_RUN,
		false,
	);
}

export function latestBenchmarkInferenceProgressAt(input: {
	startedAt?: Date | null;
	sessionUpdatedAt?: Date | null;
	latestEventCreatedAt?: Date | null;
}): Date | null {
	const timestamps = [
		input.startedAt,
		input.sessionUpdatedAt,
		input.latestEventCreatedAt,
	].filter((value): value is Date => value instanceof Date && !Number.isNaN(value.getTime()));
	if (timestamps.length === 0) return null;
	return timestamps.reduce((latest, value) =>
		value.getTime() > latest.getTime() ? value : latest,
	);
}

export function benchmarkInferenceStallState(input: {
	now: Date;
	stallSeconds: number;
	startedAt?: Date | null;
	sessionUpdatedAt?: Date | null;
	latestEventCreatedAt?: Date | null;
}): { stalled: boolean; lastProgressAt: Date | null; stalledSeconds: number } {
	const lastProgressAt = latestBenchmarkInferenceProgressAt(input);
	if (!lastProgressAt) {
		return { stalled: false, lastProgressAt: null, stalledSeconds: 0 };
	}
	const stalledSeconds = Math.max(
		0,
		Math.floor((input.now.getTime() - lastProgressAt.getTime()) / 1000),
	);
	return {
		stalled: stalledSeconds >= input.stallSeconds,
		lastProgressAt,
		stalledSeconds,
	};
}

async function timeoutBenchmarkInstanceIfStalled(
	runInstance: typeof benchmarkRunInstances.$inferSelect,
) {
	if (
		runInstance.status !== "inferencing" ||
		runInstance.inferenceStatus !== "inferencing"
	) {
		return null;
	}
	const database = requireDb();
	const sessionRows = runInstance.sessionId
		? await database
				.select({
					id: sessions.id,
					updatedAt: sessions.updatedAt,
					sandboxName: sessions.sandboxName,
					workspaceSandboxName: sessions.workspaceSandboxName,
				})
				.from(sessions)
				.where(eq(sessions.id, runInstance.sessionId))
				.limit(1)
		: runInstance.workflowExecutionId
			? await database
					.select({
						id: sessions.id,
						updatedAt: sessions.updatedAt,
						sandboxName: sessions.sandboxName,
						workspaceSandboxName: sessions.workspaceSandboxName,
					})
					.from(sessions)
					.where(eq(sessions.workflowExecutionId, runInstance.workflowExecutionId))
					.limit(1)
			: [];
	const session = sessionRows[0] ?? null;
	const latestEventRows = session
		? await database
				.select({ createdAt: sessionEvents.createdAt })
				.from(sessionEvents)
				.where(eq(sessionEvents.sessionId, session.id))
				.orderBy(desc(sessionEvents.createdAt))
				.limit(1)
		: [];

	if (session?.id && session.id !== runInstance.sessionId) {
		await database
			.update(benchmarkRunInstances)
			.set({ sessionId: session.id })
			.where(eq(benchmarkRunInstances.id, runInstance.id));
	}

	const stallSeconds = benchmarkInferenceStallSeconds();
	const state = benchmarkInferenceStallState({
		now: new Date(),
		stallSeconds,
		startedAt: runInstance.startedAt,
		sessionUpdatedAt: session?.updatedAt,
		latestEventCreatedAt: latestEventRows[0]?.createdAt,
	});
	if (!state.stalled) {
		return session?.id && session.id !== runInstance.sessionId
			? { ...runInstance, sessionId: session.id }
			: null;
	}

	const message = `Inference stalled: no session progress for ${stallSeconds}s`;
	const now = new Date();
	const executionRows = runInstance.workflowExecutionId
		? await database
				.select({
					primaryTraceId: workflowExecutions.primaryTraceId,
					output: workflowExecutions.output,
				})
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, runInstance.workflowExecutionId))
				.limit(1)
		: [];
	const sessionEventRows = session?.id
		? await database
				.select({ data: sessionEvents.data })
				.from(sessionEvents)
				.where(eq(sessionEvents.sessionId, session.id))
				.orderBy(asc(sessionEvents.sequence))
		: [];
	const runtimeLinks = extractBenchmarkRuntimeLinks({
		currentSandboxName: runInstance.sandboxName,
		currentWorkspaceRef: runInstance.workspaceRef,
		currentTraceIds: runInstance.traceIds,
		sessionSandboxName: session?.sandboxName,
		sessionWorkspaceSandboxName: session?.workspaceSandboxName,
		values: [
			{ primaryTraceId: executionRows[0]?.primaryTraceId },
			executionRows[0]?.output,
			...sessionEventRows.map((event) => event.data),
		],
	});
	const [updated] = await database
		.update(benchmarkRunInstances)
		.set({
			status: "timeout",
			inferenceStatus: "timeout",
			terminationReason: "no_session_progress",
			error: message,
			inferenceError: message,
			inferenceCompletedAt: runInstance.inferenceCompletedAt ?? now,
			sessionId: session?.id ?? runInstance.sessionId,
			sandboxName: runtimeLinks.sandboxName,
			workspaceRef: runtimeLinks.workspaceRef,
			traceIds: runtimeLinks.traceIds,
			updatedAt: now,
		})
		.where(eq(benchmarkRunInstances.id, runInstance.id))
		.returning();
	if (updated) {
		await cleanupStalledBenchmarkInstanceWorkflows(
			updated,
			session?.id ?? runInstance.sessionId,
			message,
			now,
		);
	}
	await recomputeRunSummary(runInstance.runId);
	if (updated) {
		await syncBenchmarkInstanceMlflowAndTraceBundle({
			runId: runInstance.runId,
			instanceId: runInstance.instanceId,
		});
	}
	return updated ?? null;
}

async function cleanupStalledBenchmarkInstanceWorkflows(
	runInstance: typeof benchmarkRunInstances.$inferSelect,
	sessionId: string | null,
	reason: string,
	now = new Date(),
) {
	const database = requireDb();
	try {
		const runRows = await database
			.select({ runtimeAppId: benchmarkRuns.agentRuntimeAppId })
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, runInstance.runId))
			.limit(1);
		const executionRows = runInstance.workflowExecutionId
			? await database
					.select({
						id: workflowExecutions.id,
						daprInstanceId: workflowExecutions.daprInstanceId,
						status: workflowExecutions.status,
						phase: workflowExecutions.phase,
					})
					.from(workflowExecutions)
					.where(eq(workflowExecutions.id, runInstance.workflowExecutionId))
					.limit(1)
			: [];
		const execution = executionRows[0] ?? null;
		const parentDaprInstanceId =
			execution?.daprInstanceId ?? runInstance.daprInstanceId;

		const runtimeAppId = runRows[0]?.runtimeAppId ?? null;
		let allDurableInstancesClosed = true;
		if (runtimeAppId && sessionId) {
			const turnRows = await database
				.select({
					sessionId: sessionEvents.sessionId,
					data: sessionEvents.data,
					sequence: sessionEvents.sequence,
				})
				.from(sessionEvents)
				.where(
					and(
						eq(sessionEvents.sessionId, sessionId),
						eq(sessionEvents.type, "session.turn_started"),
					),
				)
				.orderBy(asc(sessionEvents.sequence));
			const turns = turnRows.map((turnRow) => {
				const data =
					turnRow.data &&
					typeof turnRow.data === "object" &&
					!Array.isArray(turnRow.data)
						? (turnRow.data as Record<string, unknown>)
						: {};
				const rawTurn = Number(data.turn);
				return {
					sessionId: turnRow.sessionId,
					childInstanceId:
						typeof data.childInstanceId === "string"
							? data.childInstanceId
							: typeof data.child_instance_id === "string"
								? data.child_instance_id
								: null,
					turn: Number.isFinite(rawTurn) ? rawTurn : null,
				};
			});
			const runtimeInstanceIds = benchmarkAgentRuntimeCleanupInstanceIds(
				{
					runtimeAppId,
					sessionId,
					turnCount: runInstance.turnCount,
				},
				turns,
			);
			await runWithConcurrency(
				runtimeInstanceIds,
				BENCHMARK_TERMINATION_CONCURRENCY,
				async (instanceId) => {
					const closed = await terminateAndPurgeBenchmarkAgentRuntimeInstance(
						runtimeAppId,
						instanceId,
						reason,
					);
					if (!closed) allDurableInstancesClosed = false;
				},
			);
		}

		if (parentDaprInstanceId) {
			const closed = await terminateAndPurgeBenchmarkWorkflowInstance(
				parentDaprInstanceId,
				reason,
			);
			if (!closed) allDurableInstancesClosed = false;
		}

		if (!allDurableInstancesClosed) {
			console.warn(
				`Stalled benchmark instance ${runInstance.runId}/${runInstance.instanceId} durable cleanup did not confirm every workflow closed; leaving session/execution rows active for retry`,
			);
			return;
		}

		if (sessionId) {
			await database
				.update(sessions)
				.set({ status: "terminated", updatedAt: now })
				.where(
					and(
						eq(sessions.id, sessionId),
						inArray(sessions.status, ["pending", "running", "rescheduling"]),
					),
				);
		}

		if (execution?.id) {
			await database
				.update(workflowExecutions)
				.set({
					status: "error",
					phase: "failed",
					error: reason,
					completedAt: now,
				})
				.where(
					and(
						eq(workflowExecutions.id, execution.id),
						or(
							eq(workflowExecutions.status, "pending"),
							eq(workflowExecutions.status, "running"),
							eq(workflowExecutions.phase, "running"),
						),
					),
				);
		}
	} catch (err) {
		console.warn(
			`Failed to clean up stalled benchmark instance ${runInstance.runId}/${runInstance.instanceId}:`,
			err instanceof Error ? err.message : err,
		);
	}
}

export async function markBenchmarkInstanceInferenceFailure(params: {
	runId: string;
	instanceId: string;
	status: Extract<BenchmarkInferenceStatus, "error" | "timeout" | "cancelled">;
	error?: string | null;
	terminationReason?: string | null;
}) {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(benchmarkRunInstances)
		.where(
			and(
				eq(benchmarkRunInstances.runId, params.runId),
				eq(benchmarkRunInstances.instanceId, params.instanceId),
			),
		)
		.limit(1);
	if (!row) return null;
	if (INSTANCE_TERMINAL_STATUSES.has(row.status)) return row;
	const now = new Date();
	const nextVisibleStatus = resolveBenchmarkInstanceStatusAfterInference(
		row.status,
		params.status,
	);
	const keepEvaluationOwnedError =
		row.status === "evaluating" || INSTANCE_TERMINAL_STATUSES.has(row.status);
	const inferenceError = params.error?.trim() || null;
	const [updated] = await database
		.update(benchmarkRunInstances)
		.set({
			status: nextVisibleStatus,
			inferenceStatus: params.status,
			inferenceError,
			error: keepEvaluationOwnedError ? row.error : inferenceError,
			terminationReason: params.terminationReason ?? row.terminationReason,
			inferenceCompletedAt: row.inferenceCompletedAt ?? now,
			updatedAt: now,
		})
		.where(eq(benchmarkRunInstances.id, row.id))
		.returning();
	if (updated) {
		await aggregateBenchmarkInstanceTimings(updated.id);
	}
	await recomputeRunSummary(params.runId);
	if (updated) {
		await syncBenchmarkInstanceMlflowAndTraceBundle({
			runId: params.runId,
			instanceId: params.instanceId,
		});
	}
	return updated ?? null;
}

export async function upsertPredictionsArtifact(
	runId: string,
	predictionsPath: string,
) {
	const database = requireDb();
	const jsonl = await buildPredictionsJsonlForRunById(runId);
	const digest = sha256(jsonl);
	await database
		.insert(benchmarkArtifacts)
		.values({
			runId,
			kind: "predictions_jsonl",
			path: predictionsPath,
			contentType: "application/jsonl",
			sizeBytes: Buffer.byteLength(jsonl, "utf8"),
			sha256: digest,
		});
	await database
		.update(benchmarkRuns)
		.set({ predictionsPath, updatedAt: new Date() })
		.where(eq(benchmarkRuns.id, runId));
	await syncBenchmarkRunMlflow(runId);
}

export async function buildSwebenchDatasetJsonlForRunById(runId: string): Promise<string> {
	const rows = await loadSwebenchDatasetRowsForRun(runId);
	return buildSwebenchDatasetJsonl(rows);
}

export async function upsertEvaluationDatasetArtifact(
	runId: string,
	datasetPath: string,
) {
	const database = requireDb();
	const jsonl = await buildSwebenchDatasetJsonlForRunById(runId);
	await database.insert(benchmarkArtifacts).values({
		runId,
		kind: "dataset_jsonl",
		path: datasetPath,
		contentType: "application/jsonl",
		sizeBytes: Buffer.byteLength(jsonl, "utf8"),
		sha256: sha256(jsonl),
		metadata: { source: "workflow-builder-db" },
	});
	await syncBenchmarkRunMlflow(runId);
}

async function buildPredictionsJsonlForRunById(runId: string): Promise<string> {
	const database = requireDb();
	const [run] = await database
		.select()
		.from(benchmarkRuns)
		.where(eq(benchmarkRuns.id, runId))
		.limit(1);
	if (!run) throw new Error("Benchmark run not found");
	const rows = await database
		.select({
			instanceId: benchmarkRunInstances.instanceId,
			modelPatch: benchmarkRunInstances.modelPatch,
		})
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId))
		.orderBy(benchmarkRunInstances.createdAt);
	return buildPredictionsJsonl(
		rows.map((row) =>
			buildSwebenchPrediction({
				instanceId: row.instanceId,
				modelNameOrPath: run.modelNameOrPath,
				modelPatch: row.modelPatch,
			}),
		),
	);
}

async function loadSwebenchDatasetRowsForRun(runId: string) {
	const database = requireDb();
	const rows = await database
		.select({
			instanceId: benchmarkRunInstances.instanceId,
			repo: benchmarkInstances.repo,
			baseCommit: benchmarkInstances.baseCommit,
			problemStatement: benchmarkInstances.problemStatement,
			hintsText: benchmarkInstances.hintsText,
			testMetadata: benchmarkInstances.testMetadata,
			goldPatch: benchmarkInstances.goldPatch,
			metadata: benchmarkInstances.metadata,
		})
		.from(benchmarkRunInstances)
		.leftJoin(
			benchmarkInstances,
			eq(benchmarkInstances.id, benchmarkRunInstances.benchmarkInstanceId),
		)
		.where(eq(benchmarkRunInstances.runId, runId))
		.orderBy(benchmarkRunInstances.createdAt);
	const missing = rows
		.filter((row) => !isCompleteSwebenchInstanceMetadata(row))
		.map((row) => row.instanceId);
	if (missing.length > 0) {
		throw error(
			409,
			`SWE-bench metadata has not been imported for ${missing.length} selected instance(s): ${missing.slice(0, 20).join(", ")}`,
		);
	}
	return rows.map((row) => ({
		instanceId: row.instanceId,
		repo: row.repo,
		baseCommit: row.baseCommit,
		problemStatement: row.problemStatement,
		hintsText: row.hintsText,
		testMetadata: row.testMetadata ?? {},
		goldPatch: row.goldPatch,
		metadata: row.metadata ?? {},
	}));
}

async function resolveBenchmarkAgent(params: {
	projectId: string;
	agentId: string;
	version?: number;
	requestedModelNameOrPath?: string | null;
}): Promise<ValidBenchmarkAgent & { config: AgentConfig }> {
	const database = requireDb();
	const versionCond: SQL | undefined =
		typeof params.version === "number"
			? eq(agentVersions.version, params.version)
			: undefined;
	const rows = await database
		.select({
			id: agents.id,
			name: agents.name,
			slug: agents.slug,
			runtime: agents.runtime,
			runtimeAppId: agents.runtimeAppId,
			currentVersionId: agents.currentVersionId,
			registryStatus: agents.registryStatus,
			isArchived: agents.isArchived,
			projectId: agents.projectId,
			version: agentVersions.version,
			config: agentVersions.config,
		})
		.from(agents)
		.innerJoin(
			agentVersions,
			typeof params.version === "number"
				? and(
						eq(agentVersions.agentId, agents.id),
						eq(agentVersions.version, params.version),
					)
				: eq(agentVersions.id, agents.currentVersionId),
		)
		.where(
			and(
				eq(agents.id, params.agentId),
				eq(agents.projectId, params.projectId),
				versionCond,
			),
		)
		.limit(1);
	const candidate = rows[0];
	const config = (candidate?.config ?? {}) as AgentConfig;
	const modelSpec =
		typeof config.modelSpec === "string" ? config.modelSpec : null;
	const valid = assertDaprAgentPyBenchmarkAgent(
		candidate ? { ...candidate, modelSpec } : null,
		{ requestedModelNameOrPath: params.requestedModelNameOrPath },
	);
	return {
		...valid,
		config,
	};
}

async function ensureHiddenBenchmarkWorkflow(params: {
	projectId: string;
	userId: string;
}) {
	const database = requireDb();
	const graph = buildSwebenchInstanceWorkflowGraph();
	const [existing] = await database
		.select()
		.from(workflows)
		.where(
			and(
				eq(workflows.projectId, params.projectId),
				eq(workflows.name, HIDDEN_WORKFLOW_NAME),
			),
		)
		.limit(1);
	if (existing) {
		const currentNodes = Array.isArray(existing.nodes) ? existing.nodes : [];
		const currentEdges = Array.isArray(existing.edges) ? existing.edges : [];
		if (
			JSON.stringify(currentNodes) !== JSON.stringify(graph.nodes) ||
			JSON.stringify(currentEdges) !== JSON.stringify(graph.edges)
		) {
			const [updated] = await database
				.update(workflows)
				.set({
					nodes: graph.nodes,
					edges: graph.edges,
				})
				.where(eq(workflows.id, existing.id))
				.returning();
			return updated ?? existing;
		}
		return existing;
	}
	const [created] = await database
		.insert(workflows)
		.values({
			name: HIDDEN_WORKFLOW_NAME,
			description: "Internal generated workflow used by SWE-bench runs.",
			userId: params.userId,
			projectId: params.projectId,
			nodes: graph.nodes,
			edges: graph.edges,
			spec: null,
			visibility: "private",
			engineType: "dapr",
		})
		.returning();
	return created;
}

export function buildSwebenchInstanceWorkflowGraph(): {
	nodes: Array<Record<string, unknown>>;
	edges: Array<Record<string, unknown>>;
} {
	const taskConfigById: Record<string, Record<string, unknown>> = {
		workspace_profile: { call: "workspace/profile" },
		checkout_repo: { call: "workspace/command" },
		solve: { call: "durable/run" },
		extract_patch: { call: "workspace/command" },
		cleanup_workspace: { call: "workspace/cleanup" },
	};
	const node = (
		id: string,
		type: string,
		label: string,
		y: number,
		taskConfig?: Record<string, unknown>,
	) => ({
		id,
		type,
		position: { x: 250, y },
		data: {
			label,
			type,
			...(taskConfig ? { taskConfig } : {}),
			status: "idle",
			enabled: true,
		},
	});
	const nodes = [
		node("__start__", "start", "Start", 50, {}),
		node("workspace_profile", "call", "Workspace Profile", 180, taskConfigById.workspace_profile),
		node("checkout_repo", "call", "Checkout Repo", 320, taskConfigById.checkout_repo),
		node("solve", "agent", "Solve", 460, taskConfigById.solve),
		node("extract_patch", "call", "Extract Patch", 600, taskConfigById.extract_patch),
		node("cleanup_workspace", "call", "Cleanup Workspace", 740, taskConfigById.cleanup_workspace),
		node("__end__", "end", "End", 880),
	];
	const edgeIds = [
		["__start__", "workspace_profile"],
		["workspace_profile", "checkout_repo"],
		["checkout_repo", "solve"],
		["solve", "extract_patch"],
		["extract_patch", "cleanup_workspace"],
		["cleanup_workspace", "__end__"],
	];
	return {
		nodes,
		edges: edgeIds.map(([source, target]) => ({
			id: `${source}->${target}`,
			source,
			target,
		})),
	};
}

export function buildSwebenchInstanceWorkflowSpec(params: {
	runId?: string;
	suiteSlug: SwebenchSuiteSlug;
	datasetName: string;
	instanceId: string;
	repo: string;
	baseCommit: string;
	problemStatement: string;
	hintsText: string | null;
	testMetadata?: Record<string, unknown> | null;
	agentId: string;
	agentVersion: number;
	timeoutSeconds: number;
	maxTurns: number | null;
	inferenceEnvironment: ResolvedSwebenchInferenceEnvironment;
}): Record<string, unknown> {
	const inferenceEnvironment = requireValidatedBenchmarkInferenceEnvironment(
		params.inferenceEnvironment,
		params.instanceId,
	);
	const timeoutMinutes = Math.max(1, Math.ceil(params.timeoutSeconds / 60));
	const ttlSeconds = Math.max(
		params.timeoutSeconds + 3600,
		SWEBENCH_SANDBOX_TTL_SECONDS_FALLBACK,
	);
	const keepSandboxAfterRun = shouldKeepSwebenchSandboxAfterRun();
	const workspaceRef = buildStableWorkspaceRef("swebench", [
		params.runId,
		params.instanceId,
	]);
	const agentVisibleInferenceEnvironment =
		buildAgentVisibleSwebenchEnvironmentConfig(inferenceEnvironment);
	const agentVisibleEnvironmentConfig = {
		swebenchInferenceEnvironment: agentVisibleInferenceEnvironment,
	};
	const workspaceProfileWith: Record<string, unknown> = {
		rootPath: SWEBENCH_FALLBACK_WORKSPACE_ROOT,
		workspaceRef,
		sandboxTemplate: inferenceEnvironment.sandboxTemplate || "dapr-agent",
		ttlSeconds,
		keepAfterRun: keepSandboxAfterRun,
		managedBy: "workflow-builder:swebench",
		name: `swebench-${params.instanceId}`,
		enabledTools: [
			"execute_command",
			"read_file",
			"write_file",
			"edit_file",
			"list_files",
			"mkdir",
			"file_stat",
		],
		sandboxPolicy: {
			keepAfterRun: keepSandboxAfterRun,
			mode: "per-run",
			template: inferenceEnvironment.sandboxTemplate || "dapr-agent",
			ttlSeconds,
		},
		commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
		timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS + 300_000,
		sandboxImage: inferenceEnvironment.sandboxImage,
		environmentConfig: agentVisibleEnvironmentConfig,
	};
	const extractPatchCommand = [
		"set -eu",
		`cd ${quoteShell(SWEBENCH_FALLBACK_REPO_PATH)}`,
		"rm -rf /sandbox/.cache .cache",
		[
			`git diff --binary ${quoteShell(params.baseCommit)} -- .`,
			...SWEBENCH_PATCH_EXCLUDE_PATHS.map((path) => quoteShell(path)),
		].join(" \\\n  "),
	].join("\n");
	const checkoutCommand = [
		"set -eu",
		"cd /sandbox",
		"rm -rf repo",
		"mkdir -p repo",
		"cd repo",
		"git init -q",
		`git remote add origin ${quoteShell(`https://github.com/${params.repo}.git`)}`,
		`if ! git -c protocol.version=2 fetch --depth=1 origin ${quoteShell(params.baseCommit)}; then`,
		"  cd /sandbox",
		"  rm -rf repo",
		`  git clone --filter=blob:none --no-checkout ${quoteShell(`https://github.com/${params.repo}.git`)} repo`,
		"  cd repo",
		`  git fetch --depth=1 origin ${quoteShell(params.baseCommit)} || git fetch origin ${quoteShell(params.baseCommit)}`,
		"fi",
		"git checkout --force FETCH_HEAD",
		"git status --short",
	].join("\n");
	const basePrompt = buildSwebenchPrompt({
		...params,
		inferenceEnvironment,
	});
	return {
		document: {
			dsl: "1.0.0",
			namespace: "workflow-builder.benchmarks",
			name: "swebench-instance",
			version: "1.0.0",
			title: "SWE-bench instance",
			summary: "Run one SWE-bench instance through a published dapr-agent-py agent.",
		},
		do: [
			{
				workspace_profile: {
					call: "workspace/profile",
					with: workspaceProfileWith,
				},
			},
			{
				checkout_repo: {
					call: "workspace/command",
					with: {
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						command: checkoutCommand,
						timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
					},
				},
			},
			{
				solve: {
					call: "durable/run",
					with: {
						body: {
							agentRef: {
								id: params.agentId,
								version: params.agentVersion,
							},
							environmentConfig: agentVisibleEnvironmentConfig,
							overrides: {
								cwd: SWEBENCH_FALLBACK_REPO_PATH,
								maxTurns: params.maxTurns ?? undefined,
								timeoutMinutes,
								tools: SWEBENCH_ALLOWED_AGENT_TOOLS,
							},
							maxTurns: params.maxTurns ?? undefined,
							timeoutMinutes,
							prompt: basePrompt,
						},
						mode: "execute_direct",
						cwd: SWEBENCH_FALLBACK_REPO_PATH,
						sandboxName: "${ .workspace_profile.sandboxName }",
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						sandboxPolicy: {
							keepAfterRun: keepSandboxAfterRun,
							mode: "per-run",
							template: inferenceEnvironment.sandboxTemplate || "dapr-agent",
							ttlSeconds,
						},
					},
				},
			},
			{
				extract_patch: {
					call: "workspace/command",
					with: {
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						command: extractPatchCommand,
						timeoutMs: 120_000,
					},
					output: {
						as: {
							modelPatch:
								"${ .output.result.stdout // .output.stdout // .output.result.output // .output.output // \"\" }",
							raw: "${ .output }",
						},
					},
				},
			},
			{
				cleanup_workspace: {
					call: "workspace/cleanup",
					with: {
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						sandboxName: "${ .workspace_profile.sandboxName }",
					},
				},
			},
		],
		output: {
			as: {
				instanceId: params.instanceId,
				modelPatch: "${ .extract_patch.modelPatch }",
				sessionId: "${ .solve.sessionId // .solve.agentWorkflowId // null }",
				daprInstanceId: "${ .solve.daprInstanceId // null }",
				workspaceRef: "${ .workspace_profile.workspaceRef }",
				sandboxName: "${ .workspace_profile.sandboxName }",
				inferenceEnvironment: agentVisibleInferenceEnvironment,
			},
		},
	};
}

function buildSwebenchPrompt(params: {
	suiteSlug: SwebenchSuiteSlug;
	datasetName: string;
	instanceId: string;
	repo: string;
	baseCommit: string;
	problemStatement: string;
	hintsText: string | null;
	inferenceEnvironment?: ResolvedSwebenchInferenceEnvironment | null;
}): string {
	const environmentNotes = swebenchInferenceEnvironmentPromptNotes(
		params.inferenceEnvironment,
	);
	const workspaceRoot = SWEBENCH_FALLBACK_REPO_PATH;
	return [
		`You are solving SWE-bench instance ${params.instanceId}.`,
		`Dataset: ${params.datasetName}`,
		`Repository: ${params.repo}`,
		`Base commit: ${params.baseCommit}`,
		"",
		"Problem statement:",
		params.problemStatement,
		params.hintsText ? `\nHints:\n${params.hintsText}` : "",
		"",
		"Sandbox notes:",
		`- Work only in ${workspaceRoot}.`,
		"- Do not create your own commits. The runtime may create internal checkpoint commits after Edit, Write, or Bash changes; do not revert them.",
		`- Because checkpoint commits can make plain git diff/status look clean, inspect your final patch with git diff --binary ${params.baseCommit} -- . instead of plain git diff.`,
		"- Produce the repository fix by editing implementation files only.",
		"- Do not reinstall project dependencies unless the issue explicitly requires it.",
		"- Do not edit tests, test fixtures, benchmark metadata, generated artifact files, or files that only make local tests pass.",
		"- The final benchmark patch excludes test and fixture paths; implementation fixes must be outside those paths.",
		"- Running local tests is optional and best-effort. Official grading happens later in Kubernetes-native SWE-bench evaluator TaskRuns.",
		"- Do not use web search, web fetch, external issue pages, PR pages, or solution commits. Use only the repository contents, the problem statement, and local sandbox commands.",
		...environmentNotes,
		"",
		"Make the smallest source changes needed to resolve the issue. When finished, leave the final patch applied.",
	].join("\n");
}

function buildAgentVisibleSwebenchEnvironmentConfig(
	environment: ResolvedSwebenchInferenceEnvironment,
): Record<string, unknown> {
	return {
		environmentStatus: environment.environmentStatus,
		suite: environment.suite,
		repo: environment.repo,
		version: environment.version ?? null,
		environmentSetupCommit: environment.environmentSetupCommit ?? null,
		baseCommit: environment.baseCommit ?? null,
		environmentKey: environment.environmentKey ?? null,
		buildStrategy: environment.buildStrategy ?? null,
		workspaceRoot: SWEBENCH_FALLBACK_REPO_PATH,
		condaEnvironment: environment.condaEnvironment ?? null,
		sandboxTemplate: environment.sandboxTemplate,
		sandboxImage: environment.sandboxImage ?? null,
		digest: environment.digest ?? null,
		validationStatus: environment.validationStatus ?? null,
		buildId: environment.buildId ?? null,
		source: environment.source ?? null,
		reason: environment.reason ?? null,
	};
}

function extractModelPatch(value: unknown): string {
	const candidates = collectStringsByKey(value, [
		"modelPatch",
		"model_patch",
		"stdout",
		"output",
	]);
	return candidates.find((candidate) => candidate.includes("diff --git")) ?? "";
}

export function extractAgentStopReason(
	value: unknown,
	maxTurns?: number | null,
): string | null {
	const candidates = collectStringsByKey(value, [
		"content",
		"message",
		"error",
		"reason",
	]);
	const match = candidates.find((candidate) => {
		const normalized = candidate.toLowerCase();
		return (
			normalized.includes("maximum number of reasoning steps") ||
			normalized.includes("hit max iterations") ||
			normalized.includes("reached max iterations") ||
			normalized.includes("max iterations without")
		);
	});
	if (!match) return null;
	const budget =
		typeof maxTurns === "number" && Number.isFinite(maxTurns)
			? ` after maxTurns=${maxTurns}`
			: "";
	const detail = match.trim().replace(/\s+/g, " ").slice(0, 300);
	return `Agent stopped${budget} without producing a patch: ${detail}`;
}

export function extractInferenceEnvironment(value: unknown): Record<string, unknown> | null {
	const candidates = [
		...collectRecordsByKey(value, ["inferenceEnvironment"]),
		...collectRecordsByKey(value, ["swebenchInferenceEnvironment"]),
		...collectRecordsByKey(value, ["environment"]),
	].filter(isInferenceEnvironmentRecord);
	if (!candidates.length) return null;
	const selected = candidates
		.map((candidate, index) => ({
			candidate,
			index,
			score: inferenceEnvironmentScore(candidate),
		}))
		.sort((a, b) => b.score - a.score || b.index - a.index)[0].candidate;
	return sanitizeSwebenchInferenceEnvironmentForRuntime(selected) ?? selected;
}

export function sanitizeSwebenchInferenceEnvironmentForRuntime(
	environment: Record<string, unknown> | ResolvedSwebenchInferenceEnvironment | null | undefined,
): Record<string, unknown> | null {
	if (!isRecord(environment)) return null;
	const sanitized: Record<string, unknown> = {};
	for (const key of [
		"environmentStatus",
		"suite",
		"repo",
		"version",
		"environmentSetupCommit",
		"baseCommit",
		"environmentKey",
		"sandboxTemplate",
		"sandboxImage",
		"digest",
		"validationStatus",
		"validationLogRef",
		"builtAt",
		"source",
		"reason",
		"buildStrategy",
		"envSpecHash",
		"buildId",
		"buildLogRef",
		"pipelineRunName",
		"pipelineRunNamespace",
		"condaEnvironment",
	] as const) {
		const value = environment[key];
		if (value != null) sanitized[key] = value;
	}
	sanitized.workspaceRoot = SWEBENCH_FALLBACK_REPO_PATH;
	const notes = Array.isArray(environment.environmentNotes)
		? environment.environmentNotes.filter(
				(note): note is string =>
					typeof note === "string" && !containsSensitiveSwebenchRuntimeTerm(note),
			)
		: [];
	if (environment.buildStrategy === "swebench-harness") {
		for (const note of [
			"The validated image provides the SWE-bench Python environment; the repository is cloned into /sandbox/repo for OpenShell runtime access.",
			"Use python or /sandbox/.venv/bin/python for local checks; avoid conda activation inside the solve phase.",
		]) {
			if (!notes.includes(note)) notes.push(note);
		}
	}
	if (notes.length) sanitized.environmentNotes = notes;
	return sanitized;
}

export function prevalidatedBenchmarkInferenceEnvironment(
	environment: Record<string, unknown> | ResolvedSwebenchInferenceEnvironment | null | undefined,
): ResolvedSwebenchInferenceEnvironment | null {
	const sanitized = sanitizeSwebenchInferenceEnvironmentForRuntime(environment);
	if (!sanitized) return null;
	if (sanitized.environmentStatus !== "validated") return null;
	if (typeof sanitized.sandboxImage !== "string" || !sanitized.sandboxImage.trim()) {
		return null;
	}
	if (typeof sanitized.sandboxTemplate !== "string" || !sanitized.sandboxTemplate.trim()) {
		return null;
	}
	return sanitized as unknown as ResolvedSwebenchInferenceEnvironment;
}

function requireValidatedBenchmarkInferenceEnvironment(
	environment: Record<string, unknown> | ResolvedSwebenchInferenceEnvironment | null | undefined,
	instanceId: string,
): ResolvedSwebenchInferenceEnvironment {
	const validated = prevalidatedBenchmarkInferenceEnvironment(environment);
	if (validated) return validated;
	throw new Error(
		`SWE-bench instance ${instanceId} is missing a prevalidated inference environment`,
	);
}

export function extractBenchmarkRuntimeLinks(input: {
	currentSandboxName?: string | null;
	currentWorkspaceRef?: string | null;
	currentTraceIds?: string[] | null;
	sessionSandboxName?: string | null;
	sessionWorkspaceSandboxName?: string | null;
	values: unknown[];
}): { sandboxName?: string; workspaceRef?: string; traceIds: string[] } {
	const sandboxName = firstNonBlank(
		input.currentSandboxName,
		input.sessionSandboxName,
		input.sessionWorkspaceSandboxName,
		firstStringByKey(input.values, ["sandboxName", "sandbox_name"]),
	);
	const workspaceRef = firstNonBlank(
		input.currentWorkspaceRef,
		firstStringByKey(input.values, [
			"workspaceRef",
			"workspace_ref",
			"workspace.ref",
		]),
	);
	const traceIds = collectBenchmarkTraceIds(
		{ traceIds: input.currentTraceIds ?? [] },
		...input.values,
	);
	return {
		sandboxName: sandboxName ?? undefined,
		workspaceRef: workspaceRef ?? undefined,
		traceIds,
	};
}

export function collectBenchmarkTraceIds(...values: unknown[]): string[] {
	const traceIds = new Set<string>();
	const visit = (node: unknown) => {
		if (!node) return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		if (!isRecord(node)) return;
		for (const [key, child] of Object.entries(node)) {
			if (
				(key === "traceId" ||
					key === "trace_id" ||
					key === "traceID" ||
					key === "primaryTraceId" ||
					key === "primary_trace_id") &&
				typeof child === "string" &&
				child.trim()
			) {
				traceIds.add(child.trim());
				continue;
			}
			if ((key === "traceIds" || key === "trace_ids") && Array.isArray(child)) {
				for (const traceId of child) {
					if (typeof traceId === "string" && traceId.trim()) {
						traceIds.add(traceId.trim());
					}
				}
				continue;
			}
			if (typeof child === "object" && child !== null) visit(child);
		}
	};
	for (const value of values) visit(value);
	return Array.from(traceIds);
}

function firstStringByKey(values: unknown[], keys: string[]): string | null {
	for (const value of values) {
		const found = collectStringsByKey(value, keys).find((candidate) =>
			Boolean(candidate.trim()),
		);
		if (found) return found.trim();
	}
	return null;
}

function collectStringsByKey(value: unknown, keys: string[]): string[] {
	const wanted = new Set(keys);
	const out: string[] = [];
	const visit = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(node)) {
			if (typeof child === "string" && wanted.has(key)) out.push(child);
			else visit(child);
		}
	};
	visit(value);
	return out;
}

function firstRecordByKey(value: unknown, keys: string[]): Record<string, unknown> | null {
	return collectRecordsByKey(value, keys)[0] ?? null;
}

function collectRecordsByKey(value: unknown, keys: string[]): Record<string, unknown>[] {
	const wanted = new Set(keys);
	const out: Record<string, unknown>[] = [];
	const visit = (node: unknown) => {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			for (const item of node) visit(item);
			return;
		}
		for (const [key, child] of Object.entries(node)) {
			if (wanted.has(key) && isRecord(child)) out.push(child);
			visit(child);
		}
	};
	visit(value);
	return out;
}

function inferenceEnvironmentScore(environment: Record<string, unknown>): number {
	let score = 0;
	if (environment.environmentStatus === "validated") score += 100;
	if (typeof environment.sandboxImage === "string" && environment.sandboxImage.trim()) {
		score += 40;
	}
	if (typeof environment.digest === "string" && environment.digest.trim()) score += 20;
	if (typeof environment.validationLogRef === "string" && environment.validationLogRef.trim()) {
		score += 10;
	}
	if (typeof environment.pipelineRunName === "string" && environment.pipelineRunName.trim()) {
		score += 5;
	}
	if (environment.environmentStatus === "failed") score += 2;
	if (environment.environmentStatus === "building") score -= 10;
	return score;
}

function isInferenceEnvironmentRecord(environment: Record<string, unknown>): boolean {
	return (
		typeof environment.environmentStatus === "string" ||
		typeof environment.sandboxImage === "string" ||
		typeof environment.environmentKey === "string" ||
		typeof environment.validationStatus === "string"
	);
}

function firstNonBlank(...values: Array<string | null | undefined>): string | null {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function isFailedWorkflowExecution(execution: {
	status: string;
	phase: string | null;
	error: string | null;
	output: unknown;
}): boolean {
	if (execution.status === "error" || execution.phase === "failed") return true;
	if (typeof execution.error === "string" && execution.error.trim()) return true;
	const output = execution.output;
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const success = (output as Record<string, unknown>).success;
		if (success === false) return true;
	}
	return false;
}

function workflowExecutionError(
	execution: { error: string | null; output: unknown },
	runtimeOutput: unknown,
): string | null {
	if (typeof execution.error === "string" && execution.error.trim()) {
		return execution.error;
	}
	const candidates = collectStringsByKey(runtimeOutput ?? execution.output, [
		"error",
		"stderr",
		"message",
	]);
	return candidates.find((candidate) => candidate.trim())?.slice(0, 2000) ?? null;
}

function serializeRunSummary(row: {
	run: typeof benchmarkRuns.$inferSelect;
	suiteSlug: string;
	suiteName: string;
	datasetName: string;
	agentName: string;
	agentSlug: string | null;
}) {
	return {
		id: row.run.id,
		suiteId: row.run.suiteId,
		suiteSlug: row.suiteSlug,
		suiteName: row.suiteName,
		datasetName: row.datasetName,
		agentId: row.run.agentId,
		agentName: row.agentName,
		agentSlug: row.agentSlug,
		agentVersion: row.run.agentVersion,
		agentRuntimeAppId: row.run.agentRuntimeAppId,
		status: row.run.status,
		modelNameOrPath: row.run.modelNameOrPath,
		modelConfigLabel: row.run.modelConfigLabel,
		selectedInstanceIds: row.run.selectedInstanceIds,
		concurrency: row.run.concurrency,
		evaluationConcurrency: row.run.evaluationConcurrency,
		timeoutSeconds: row.run.timeoutSeconds,
		maxTurns: row.run.maxTurns,
		evaluatorResourceClass: row.run.evaluatorResourceClass,
		coordinatorExecutionId: row.run.coordinatorExecutionId,
		evaluatorJobName: row.run.evaluatorJobName,
		predictionsPath: row.run.predictionsPath,
		mlflowExperimentId: row.run.mlflowExperimentId,
		mlflowRunId: row.run.mlflowRunId,
		mlflowUrl: publicMlflowRunUrl(row.run.mlflowExperimentId, row.run.mlflowRunId),
		summary: row.run.summary,
		tags: Array.isArray(row.run.tags) ? row.run.tags : [],
		error: row.run.error,
		cancelRequestedAt: row.run.cancelRequestedAt?.toISOString() ?? null,
		startedAt: row.run.startedAt?.toISOString() ?? null,
		completedAt: row.run.completedAt?.toISOString() ?? null,
		createdAt: row.run.createdAt.toISOString(),
		updatedAt: row.run.updatedAt.toISOString(),
	};
}

export function resolveBenchmarkInstanceStatusAfterInference(
	currentStatus: BenchmarkRunInstanceStatus,
	inferenceStatus: CompletedExecutionStatus,
): BenchmarkRunInstanceStatus {
	if (currentStatus === "evaluating" || INSTANCE_TERMINAL_STATUSES.has(currentStatus)) {
		return currentStatus;
	}
	return inferenceStatus === "success" ? "inferred" : inferenceStatus;
}

export function resolveBenchmarkInferenceStatus(
	inferenceStatus: CompletedExecutionStatus,
): BenchmarkInferenceStatus {
	return inferenceStatus === "success" ? "inferred" : inferenceStatus;
}

function mapExecutionStatus(
	dbStatus: string,
	runtimeStatus: string | null,
): ExecutionStatus {
	switch ((runtimeStatus ?? "").toUpperCase()) {
		case "COMPLETED":
			return "success";
		case "FAILED":
			return "error";
		case "TERMINATED":
		case "CANCELED":
			return "cancelled";
		case "PENDING":
			return "pending";
		case "RUNNING":
		case "SUSPENDED":
			return "running";
	}
	if (
		dbStatus === "pending" ||
		dbStatus === "running" ||
		dbStatus === "success" ||
		dbStatus === "error" ||
		dbStatus === "cancelled"
	) {
		return dbStatus;
	}
	return "running";
}

function clampInteger(
	value: unknown,
	min: number,
	max: number,
	fallback: number,
): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(Math.max(Math.floor(parsed), min), max);
}

function parseBooleanFlag(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return fallback;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return fallback;
	if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
	return fallback;
}

export function effectiveBenchmarkConcurrency(input: {
	instanceCount: number;
	concurrency?: unknown;
	evaluationConcurrency?: unknown;
	runtimeClass?: string | null;
	runtimeIsolation?: string | null;
	runtimeAppId?: string | null;
	poolMaxReplicas?: number | null;
	slotsPerReplica?: number | null;
	maxActiveSessions?: number | null;
}): { concurrency: number; evaluationConcurrency: number } {
	const instanceLimit = Math.max(1, Math.floor(input.instanceCount));
	const capacity = estimateBenchmarkRuntimeCapacity({
		runtimeClass: input.runtimeClass,
		runtimeIsolation: input.runtimeIsolation,
		runtimeAppId: input.runtimeAppId,
		poolMaxReplicas: input.poolMaxReplicas,
		slotsPerReplica: input.slotsPerReplica,
		maxActiveSessions: input.maxActiveSessions,
		requestedInstanceCount: instanceLimit,
		requestedConcurrency: input.concurrency,
	});
	return {
		concurrency: capacity.effectiveConcurrency,
		evaluationConcurrency: Math.min(
			clampInteger(
				input.evaluationConcurrency,
				1,
				128,
				DEFAULT_EVALUATION_CONCURRENCY,
			),
			instanceLimit,
		),
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function containsSensitiveSwebenchRuntimeTerm(value: string): boolean {
	return /\/testbed|test[_-]?patch|fail_to_pass|pass_to_pass|goldpatch/i.test(
		value,
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
