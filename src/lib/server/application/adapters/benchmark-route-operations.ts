import { BenchmarkAgentValidationError } from "$lib/server/benchmarks/agents";
import {
	applyBenchmarkInstanceHostExecutionUpdate,
	applyBenchmarkRunPreflight,
	buildPredictionsJsonlForRun,
	buildSwebenchDatasetJsonlForRunById,
	createBenchmarkRun,
	getBenchmarkRun,
	listBenchmarkSuites,
	markBenchmarkInstanceInferenceFailure,
	markBenchmarkRunStatus,
	recomputeRunSummary,
	retryBenchmarkRunTerminalCleanup,
	retryBenchmarkRunTerminalCleanupByRunId,
	scheduleBenchmarkRunTerminalCleanupByRunId,
	startSwebenchCoordinator,
	syncBenchmarkInstanceFromExecution,
	upsertEvaluationDatasetArtifact,
	upsertPredictionsArtifact,
	type CreateBenchmarkRunInput,
} from "$lib/server/application/adapters/benchmark-service";
import {
	acquireBenchmarkResourceLeases,
	benchmarkResourceLeaseSnapshot,
	releaseBenchmarkResourceLeases,
	type BenchmarkResourceLeaseTypeInput as LegacyBenchmarkResourceLeaseTypeInput,
} from "$lib/server/application/adapters/benchmark-resource-leases";
import { loadSwebenchTraceBundle } from "$lib/server/application/adapters/benchmark-trace-bundle";
import type {
	BenchmarkRouteOperationsPort,
	BenchmarkRunCreateInput,
	BenchmarkRunCreateResult,
	BenchmarkRunStatusInput,
	BenchmarkTraceBundleQueryOptions,
} from "$lib/server/application/benchmark-route-operations";

export class LegacyBenchmarkRouteOperationsAdapter
	implements BenchmarkRouteOperationsPort
{
	listSuites(projectId?: string | null) {
		return listBenchmarkSuites(projectId);
	}

	async createRun(
		input: BenchmarkRunCreateInput,
	): Promise<BenchmarkRunCreateResult> {
		try {
			return {
				status: "ok",
				run: await createBenchmarkRun(input as CreateBenchmarkRunInput),
			};
		} catch (err) {
			if (err instanceof BenchmarkAgentValidationError) {
				return { status: "validation_error", message: err.message };
			}
			throw err;
		}
	}

	getRun(projectId: string, runId: string) {
		return getBenchmarkRun(projectId, runId);
	}

	startCoordinator(runId: string) {
		return startSwebenchCoordinator(runId);
	}

	markStatus(
		runId: string,
		status: BenchmarkRunStatusInput,
		extra: Record<string, unknown> = {},
		options: { terminalCleanup?: "sync" | "background" } = {},
	) {
		return markBenchmarkRunStatus(
			runId,
			status,
			extra,
			options,
		);
	}

	recomputeSummary(runId: string) {
		return recomputeRunSummary(runId);
	}

	retryTerminalCleanup(projectId: string, runId: string) {
		return retryBenchmarkRunTerminalCleanup(projectId, runId);
	}

	retryTerminalCleanupByRunId(runId: string) {
		return retryBenchmarkRunTerminalCleanupByRunId(runId);
	}

	scheduleTerminalCleanupByRunId(runId: string) {
		return scheduleBenchmarkRunTerminalCleanupByRunId(runId);
	}

	buildPredictionsJsonl(projectId: string, runId: string) {
		return buildPredictionsJsonlForRun(projectId, runId);
	}

	loadTraceBundle(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		options?: BenchmarkTraceBundleQueryOptions;
	}) {
		return loadSwebenchTraceBundle(input);
	}

	applyPreflight(input: {
		runId: string;
		inferenceEnvironmentsByInstanceId: Record<string, unknown>;
		preflightSummary?: Record<string, unknown> | null;
		capacitySnapshot?: Record<string, unknown> | null;
	}) {
		return applyBenchmarkRunPreflight(input);
	}

	applyInstanceHostExecutionUpdate(input: {
		runId: string;
		instanceId: string;
		status: unknown;
		hostExecutionId?: string | null;
		daprInstanceId?: string | null;
		jobName?: string | null;
		output?: unknown;
		error?: string | null;
		sandboxName?: string | null;
		workspaceRef?: string | null;
		traceIds?: string[] | null;
		inferenceEnvironment?: Record<string, unknown> | null;
		terminationReason?: string | null;
		retryAfterSeconds?: number | null;
	}) {
		return applyBenchmarkInstanceHostExecutionUpdate(input);
	}

	syncInstanceFromExecution(input: { runId: string; instanceId: string }) {
		return syncBenchmarkInstanceFromExecution(input);
	}

	markInstanceInferenceFailure(input: {
		runId: string;
		instanceId: string;
		status: "error" | "timeout" | "cancelled";
		error?: string | null;
		terminationReason?: string | null;
	}) {
		return markBenchmarkInstanceInferenceFailure(input);
	}

	async upsertDatasetArtifact(runId: string, path: string) {
		await upsertEvaluationDatasetArtifact(runId, path);
	}

	buildDatasetJsonlByRunId(runId: string) {
		return buildSwebenchDatasetJsonlForRunById(runId);
	}

	async upsertPredictionsArtifact(runId: string, path: string) {
		await upsertPredictionsArtifact(runId, path);
	}

	leaseSnapshot(runId?: string | null) {
		return benchmarkResourceLeaseSnapshot(runId);
	}

	acquireLeases(input: {
		runId: string;
		instanceId?: string | null;
		phase?: string | null;
		resources?: LegacyBenchmarkResourceLeaseTypeInput[] | null;
		leaseSeconds?: number | null;
		metadata?: Record<string, unknown> | null;
	}) {
		return acquireBenchmarkResourceLeases(input);
	}

	releaseLeases(input: {
		runId: string;
		instanceId?: string | null;
		holderId?: string | null;
		phase?: string | null;
		resources?: LegacyBenchmarkResourceLeaseTypeInput[] | null;
		reason?: string | null;
	}) {
		return releaseBenchmarkResourceLeases(input);
	}
}
