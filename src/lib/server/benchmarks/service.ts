import { createHash } from "node:crypto";
import { error } from "@sveltejs/kit";
import {
	asc,
	and,
	count,
	desc,
	eq,
	inArray,
	type SQL,
} from "drizzle-orm";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import {
	agentVersions,
	agents,
	benchmarkArtifacts,
	benchmarkInstances,
	benchmarkRunInstances,
	benchmarkRuns,
	benchmarkSuites,
	sessionEvents,
	sessions,
	workflowExecutions,
	workflows,
	type BenchmarkEvaluationStatus,
	type BenchmarkInferenceStatus,
	type BenchmarkRunInstanceStatus,
	type BenchmarkRunStatus,
} from "$lib/server/db/schema";
import { daprFetch, getOrchestratorUrl } from "$lib/server/dapr-client";
import { resolveSpecAgentRefs } from "$lib/server/agents/resolver";
import {
	assertDaprAgentPyBenchmarkAgent,
	type ValidBenchmarkAgent,
} from "./agents";
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
	swebenchInferenceEnvironmentPromptNotes,
	type ResolvedSwebenchInferenceEnvironment,
} from "./inference-environments";
import { plannedSwebenchInferenceEnvironmentWithBuild } from "$lib/server/environments/environment-image-builds";
import { buildStableWorkspaceRef } from "./workspace-ref";

const HIDDEN_WORKFLOW_NAME = "SWE-bench instance runner";
const DEFAULT_TIMEOUT_SECONDS = 2 * 60 * 60;
const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
const SWEBENCH_PREPARED_REPO_PATH = "/testbed";
const SWEBENCH_FALLBACK_WORKSPACE_ROOT = "/sandbox";
const SWEBENCH_FALLBACK_REPO_PATH = "/sandbox/repo";
const SWEBENCH_RUNTIME_REPO_PATH_EXPRESSION = `\${ .prepare_environment.environment.workspaceRoot // ${JSON.stringify(SWEBENCH_FALLBACK_REPO_PATH)} }`;
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
type ExecutionStatus =
	| "pending"
	| "running"
	| "success"
	| "error"
	| "timeout"
	| "cancelled";
type CompletedExecutionStatus = Exclude<ExecutionStatus, "pending" | "running">;

function requireDb() {
	if (!db) throw error(503, "Database not configured");
	return db;
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
	}));
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
	timeoutSeconds?: number;
	maxTurns?: number | null;
	evaluatorResourceClass?: string | null;
};

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
	});

	const instanceIds = normalizeInstanceIds(input.instanceIds);
	if (instanceIds.length === 0) {
		throw error(400, "At least one SWE-bench instance id is required");
	}
	if (instanceIds.length > 500) {
		throw error(400, "A benchmark run may include at most 500 instances");
	}
	const concurrency = clampInteger(input.concurrency, 1, 32, 1);
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
		`${agent.slug}@v${agent.version}`;

	const created = await database.transaction(async (tx) => {
		const existingInstances = await tx
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

		const [run] = await tx
			.insert(benchmarkRuns)
			.values({
				projectId: input.projectId,
				userId: input.userId,
				suiteId: suite.id,
				agentId: agent.id,
				agentVersion: agent.version,
				agentRuntime: agent.runtime,
				agentRuntimeAppId: agent.runtimeAppId,
				status: "queued",
				modelNameOrPath,
				modelConfigLabel: input.modelConfigLabel?.trim() || null,
				selectedInstanceIds: instanceIds,
				concurrency,
				timeoutSeconds,
				maxTurns,
				evaluatorResourceClass,
				summary: { total: instanceIds.length, resolvedRate: 0 },
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

	return created;
}

export async function listBenchmarkRuns(projectId: string, limit = 20) {
	const database = requireDb();
	await ensureDefaultBenchmarkSuites();
	const rows = await database
		.select({
			run: benchmarkRuns,
			suiteSlug: benchmarkSuites.slug,
			suiteName: benchmarkSuites.name,
			agentName: agents.name,
			agentSlug: agents.slug,
		})
		.from(benchmarkRuns)
		.innerJoin(benchmarkSuites, eq(benchmarkSuites.id, benchmarkRuns.suiteId))
		.innerJoin(agents, eq(agents.id, benchmarkRuns.agentId))
		.where(eq(benchmarkRuns.projectId, projectId))
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
		instances: instancesRows.map(({ runInstance, repo, baseCommit, problemStatement }) => ({
			id: runInstance.id,
			instanceId: runInstance.instanceId,
			status: runInstance.status,
			inferenceStatus: runInstance.inferenceStatus,
			evaluationStatus: runInstance.evaluationStatus,
			repo,
			baseCommit,
			problemStatement,
			sessionId: runInstance.sessionId,
			workflowExecutionId: runInstance.workflowExecutionId,
			daprInstanceId: runInstance.daprInstanceId,
			sandboxName: runInstance.sandboxName,
			workspaceRef: runInstance.workspaceRef,
			traceIds: runInstance.traceIds,
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
		})),
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
	if (run.status === "cancelled") return run;
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
		await tx
			.update(benchmarkRunInstances)
			.set({
				status: "cancelled",
				inferenceStatus: "cancelled",
				evaluationStatus: "cancelled",
				updatedAt: now,
			})
			.where(
				and(
					eq(benchmarkRunInstances.runId, runId),
					inArray(benchmarkRunInstances.status, [
						"queued",
						"inferencing",
						"inferred",
						"evaluating",
					] satisfies BenchmarkRunInstanceStatus[]),
				),
			);
	});
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
	if (run.status !== status && !canTransitionBenchmarkRun(run.status, status)) {
		throw new Error(`Invalid benchmark run transition ${run.status} -> ${status}`);
	}
	const now = new Date();
	const patch: Partial<typeof benchmarkRuns.$inferInsert> = {
		status,
		updatedAt: now,
		...extra,
	};
	if (status === "inferencing" && !run.startedAt) patch.startedAt = now;
	if (status === "completed" || status === "failed" || status === "cancelled") {
		patch.completedAt = now;
	}
	const [updated] = await database
		.update(benchmarkRuns)
		.set(patch)
		.where(eq(benchmarkRuns.id, runId))
		.returning();
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
						"queued",
						"inferencing",
						"inferred",
						"failed",
						"error",
						"timeout",
					] satisfies BenchmarkRunInstanceStatus[]),
				),
			);
	}
	return updated ?? null;
}

export async function recomputeRunSummary(runId: string) {
	const database = requireDb();
	const rows = await database
		.select({ status: benchmarkRunInstances.status })
		.from(benchmarkRunInstances)
		.where(eq(benchmarkRunInstances.runId, runId));
	const summary = summarizeRunInstances(rows.map((row) => row.status));
	await database
		.update(benchmarkRuns)
		.set({ summary, updatedAt: new Date() })
		.where(eq(benchmarkRuns.id, runId));
	return summary;
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

	const workflow = await ensureHiddenBenchmarkWorkflow({
		projectId: row.run.projectId,
		userId: row.run.userId,
	});
	const inferenceEnvironment = await plannedSwebenchInferenceEnvironmentWithBuild({
		dataset: row.suite.datasetName,
		suiteSlug: normalizeSwebenchSuiteSlug(row.suite.slug),
		instanceId: row.runInstance.instanceId,
		repo: row.instance.repo,
		baseCommit: row.instance.baseCommit,
		testMetadata: row.instance.testMetadata,
	});
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
	await database
		.update(benchmarkRunInstances)
		.set({
			status: "inferencing",
			inferenceStatus: "inferencing",
			inferenceEnvironment,
			workflowExecutionId: execution.id,
			daprInstanceId,
			startedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(benchmarkRunInstances.id, row.runInstance.id));
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
			execution: workflowExecutions,
		})
		.from(benchmarkRunInstances)
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
	if (status === "running" || status === "pending") return row.runInstance;

	const patch = extractModelPatch(runtimeOutput ?? row.execution.output);
	const now = new Date();
	const inferenceError =
		status === "success" ? null : workflowExecutionError(row.execution, runtimeOutput);
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
	await recomputeRunSummary(params.runId);
	return updated ?? null;
}

export async function markBenchmarkInstanceInferenceFailure(params: {
	runId: string;
	instanceId: string;
	status: Extract<BenchmarkInferenceStatus, "error" | "timeout" | "cancelled">;
	error?: string | null;
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
			inferenceCompletedAt: row.inferenceCompletedAt ?? now,
			updatedAt: now,
		})
		.where(eq(benchmarkRunInstances.id, row.id))
		.returning();
	await recomputeRunSummary(params.runId);
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
}): Promise<ValidBenchmarkAgent> {
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
	return assertDaprAgentPyBenchmarkAgent(rows[0]);
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
		prepare_environment: { call: "environment/ensure" },
		workspace_profile: { call: "workspace/profile" },
		checkout_repo: { call: "workspace/command" },
		solve: { call: "durable/run" },
		extract_patch: { call: "workspace/command" },
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
		node("prepare_environment", "call", "Prepare Environment", 180, taskConfigById.prepare_environment),
		node("workspace_profile", "call", "Workspace Profile", 320, taskConfigById.workspace_profile),
		node("checkout_repo", "call", "Checkout Repo", 460, taskConfigById.checkout_repo),
		node("solve", "agent", "Solve", 600, taskConfigById.solve),
		node("extract_patch", "call", "Extract Patch", 740, taskConfigById.extract_patch),
		node("__end__", "end", "End", 880),
	];
	const edgeIds = [
		["__start__", "prepare_environment"],
		["prepare_environment", "workspace_profile"],
		["workspace_profile", "checkout_repo"],
		["checkout_repo", "solve"],
		["solve", "extract_patch"],
		["extract_patch", "__end__"],
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
	inferenceEnvironment?: ResolvedSwebenchInferenceEnvironment | null;
}): Record<string, unknown> {
	const timeoutMinutes = Math.max(1, Math.ceil(params.timeoutSeconds / 60));
	const ttlSeconds = Math.max(params.timeoutSeconds + 3600, 7200);
	const dynamicSandboxTemplate = "${ .prepare_environment.sandboxTemplate // \"dapr-agent\" }";
	const workspaceRef = buildStableWorkspaceRef("swebench", [
		params.runId,
		params.instanceId,
	]);
	const environmentPrepareWith = {
		dataset: "swebench",
		datasetName: params.datasetName,
		suiteSlug: params.suiteSlug,
		instanceId: params.instanceId,
		repo: params.repo,
		baseCommit: params.baseCommit,
		testMetadata: {
			...(params.testMetadata ?? {}),
			...(params.inferenceEnvironment
				? {
						version: params.inferenceEnvironment.version,
						environmentSetupCommit:
							params.inferenceEnvironment.environmentSetupCommit,
						validationCommand: params.inferenceEnvironment.validationCommand,
					}
				: {}),
		},
		timeoutMs: Math.max(params.timeoutSeconds * 1000, 3_600_000),
		pollMs: 15_000,
	};
	const workspaceProfileWith: Record<string, unknown> = {
		rootPath: SWEBENCH_FALLBACK_WORKSPACE_ROOT,
		workspaceRef,
		sandboxTemplate: dynamicSandboxTemplate,
		ttlSeconds,
		keepAfterRun: true,
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
			keepAfterRun: true,
			mode: "per-run",
			template: dynamicSandboxTemplate,
			ttlSeconds,
		},
		commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
		timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS + 300_000,
	};
	workspaceProfileWith.sandboxImage = "${ .prepare_environment.sandboxImage }";
	workspaceProfileWith.environmentConfig = {
		swebenchInferenceEnvironment: "${ .prepare_environment.environment }",
	};
	const fallbackExtractPatchCommand = [
		"set -eu",
		`cd ${quoteShell(SWEBENCH_FALLBACK_REPO_PATH)}`,
		"rm -rf /sandbox/.cache .cache",
		[
			`git diff --binary ${quoteShell(params.baseCommit)} -- .`,
			...SWEBENCH_PATCH_EXCLUDE_PATHS.map((path) => quoteShell(path)),
		].join(" \\\n  "),
	].join("\n");
	const preparedExtractPatchCommand = [
		"set -eu",
		`cd ${quoteShell(SWEBENCH_PREPARED_REPO_PATH)}`,
		"rm -rf /sandbox/.cache .cache",
		[
			`git diff --binary ${quoteShell(params.baseCommit)} -- .`,
			...SWEBENCH_PATCH_EXCLUDE_PATHS.map((path) => quoteShell(path)),
		].join(" \\\n  "),
	].join("\n");
	const extractPatchCommand = swebenchRuntimeRepoPathChoiceExpression(
		preparedExtractPatchCommand,
		fallbackExtractPatchCommand,
	);
	const fallbackCheckoutCommand = [
		"set -eu",
		"cd /sandbox",
		"rm -rf repo",
		`git clone ${quoteShell(`https://github.com/${params.repo}.git`)} repo`,
		"cd repo",
		`git checkout ${quoteShell(params.baseCommit)}`,
		"git status --short",
	].join("\n");
	const checkoutCommand = swebenchRuntimeRepoPathChoiceExpression(
		buildPreparedTestbedCheckCommand(params.baseCommit),
		fallbackCheckoutCommand,
	);
	const preparedPrompt = buildSwebenchPrompt({
		...params,
		inferenceEnvironment: null,
		workspaceRoot: SWEBENCH_PREPARED_REPO_PATH,
	});
	const fallbackPrompt = buildSwebenchPrompt({
		...params,
		inferenceEnvironment: null,
		workspaceRoot: SWEBENCH_FALLBACK_REPO_PATH,
	});
	const prompt = buildSwebenchPromptExpression(preparedPrompt, fallbackPrompt);
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
				prepare_environment: {
					call: "environment/ensure",
					with: environmentPrepareWith,
				},
			},
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
							environmentConfig: {
								swebenchInferenceEnvironment:
									"${ .prepare_environment.environment }",
							},
							overrides: {
								cwd: SWEBENCH_RUNTIME_REPO_PATH_EXPRESSION,
								maxTurns: params.maxTurns ?? undefined,
								timeoutMinutes,
								tools: SWEBENCH_ALLOWED_AGENT_TOOLS,
							},
							prompt,
						},
						mode: "execute_direct",
						cwd: SWEBENCH_RUNTIME_REPO_PATH_EXPRESSION,
						sandboxName: "${ .workspace_profile.sandboxName }",
						workspaceRef: "${ .workspace_profile.workspaceRef }",
						sandboxPolicy: {
							keepAfterRun: true,
							mode: "per-run",
							template: dynamicSandboxTemplate,
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
		],
		output: {
			as: {
				instanceId: params.instanceId,
				modelPatch: "${ .extract_patch.modelPatch }",
				sessionId: "${ .solve.sessionId // .solve.agentWorkflowId // null }",
				daprInstanceId: "${ .solve.daprInstanceId // null }",
				workspaceRef: "${ .workspace_profile.workspaceRef }",
				sandboxName: "${ .workspace_profile.sandboxName }",
				inferenceEnvironment: "${ .prepare_environment.environment // null }",
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
	workspaceRoot?: string | null;
}): string {
	const environmentNotes = swebenchInferenceEnvironmentPromptNotes(
		params.inferenceEnvironment,
	);
	const workspaceRoot = params.workspaceRoot ?? params.inferenceEnvironment?.workspaceRoot ?? "/sandbox/repo";
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
		workspaceRoot === "/testbed"
			? "- The repository is already checked out and prepared under /testbed."
			: "",
		workspaceRoot === "/testbed"
			? "- Dependencies are installed according to the SWE-bench harness spec in the conda testbed environment."
			: "",
		"- Do not create commits; leave source changes in the working tree.",
		"- Produce the repository fix by editing implementation files only.",
		"- Do not reinstall project dependencies unless the issue explicitly requires it.",
		"- Do not edit tests, test fixtures, benchmark metadata, generated artifact files, or files that only make local tests pass.",
		"- The final benchmark patch excludes test and fixture paths; implementation fixes must be outside those paths.",
		"- Running local tests is optional and best-effort. Official grading happens later in a Docker SWE-bench evaluator job.",
		"- Do not use web search, web fetch, external issue pages, PR pages, or solution commits. Use only the repository contents, the problem statement, and local sandbox commands.",
		...environmentNotes,
		"",
		"Make the smallest source changes needed to resolve the issue. When finished, leave the final patch applied.",
	].join("\n");
}

function buildSwebenchPromptExpression(preparedPrompt: string, fallbackPrompt: string): string {
	return `\${ ${swebenchRuntimeRepoPathChoiceProgram(preparedPrompt, fallbackPrompt)} + "\\n\\nInference environment:\\n" + (.prepare_environment.promptNotes // "Environment metadata is attached to this run.") }`;
}

function swebenchRuntimeRepoPathChoiceExpression(preparedValue: string, fallbackValue: string): string {
	return `\${ ${swebenchRuntimeRepoPathChoiceProgram(preparedValue, fallbackValue)} }`;
}

function swebenchRuntimeRepoPathChoiceProgram(preparedValue: string, fallbackValue: string): string {
	return `if ((.prepare_environment.environment.workspaceRoot // ${JSON.stringify(SWEBENCH_FALLBACK_REPO_PATH)}) == ${JSON.stringify(SWEBENCH_PREPARED_REPO_PATH)}) then ${JSON.stringify(preparedValue)} else ${JSON.stringify(fallbackValue)} end`;
}

function buildPreparedTestbedCheckCommand(baseCommit: string): string {
	return [
		"set -eu",
		"cd /testbed",
		"git rev-parse --is-inside-work-tree >/dev/null",
		`git cat-file -e ${quoteShell(`${baseCommit}^{commit}`)}`,
		`git merge-base --is-ancestor ${quoteShell(baseCommit)} HEAD`,
		"git status --short",
	].join("\n");
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

export function extractInferenceEnvironment(value: unknown): Record<string, unknown> | null {
	const candidates = [
		...collectRecordsByKey(value, ["inferenceEnvironment"]),
		...collectRecordsByKey(value, ["swebenchInferenceEnvironment"]),
		...collectRecordsByKey(value, ["environment"]),
	].filter(isInferenceEnvironmentRecord);
	if (!candidates.length) return null;
	return candidates
		.map((candidate, index) => ({
			candidate,
			index,
			score: inferenceEnvironmentScore(candidate),
		}))
		.sort((a, b) => b.score - a.score || b.index - a.index)[0].candidate;
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
	agentName: string;
	agentSlug: string | null;
}) {
	return {
		id: row.run.id,
		suiteId: row.run.suiteId,
		suiteSlug: row.suiteSlug,
		suiteName: row.suiteName,
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
		timeoutSeconds: row.run.timeoutSeconds,
		maxTurns: row.run.maxTurns,
		evaluatorResourceClass: row.run.evaluatorResourceClass,
		coordinatorExecutionId: row.run.coordinatorExecutionId,
		evaluatorJobName: row.run.evaluatorJobName,
		predictionsPath: row.run.predictionsPath,
		summary: row.run.summary,
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

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function quoteShell(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
