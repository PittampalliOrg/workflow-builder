export type BenchmarkRunStatusInput =
	| "queued"
	| "inferencing"
	| "evaluating"
	| "completed"
	| "failed"
	| "cancelled";

export type BenchmarkResourceLeaseTypeInput =
	| "inference_slot"
	| "openshell_sandbox"
	| "agent_runtime_slot"
	| "dapr_workflow_slot"
	| "evaluator_slot"
	| "model_slot";

export type BenchmarkRunCreateInput = {
	projectId: string;
	userId: string;
	suiteSlug: string;
	agentId?: string;
	agentSlug?: string | null;
	agentVersion?: number;
	instanceIds: unknown;
	modelNameOrPath?: string;
	modelConfigLabel?: string | null;
	concurrency?: number;
	evaluationConcurrency?: number;
	timeoutSeconds?: number;
	maxTurns?: number | null;
	evaluatorResourceClass?: string | null;
	tags?: string[];
	requirePrevalidatedEnvironments?: boolean;
	executionBackend?: string | null;
	executionClass?: string | null;
};

export type BenchmarkRunCreateResult =
	| { status: "ok"; run: Record<string, unknown> }
	| { status: "validation_error"; message: string };

export type BenchmarkTraceBundleQueryOptions = {
	limit?: number;
	cursor?: string | null;
	timeWindow?: {
		startedAt?: string | null;
		completedAt?: string | null;
	};
};

export type BenchmarkRouteOperationsPort = {
	listSuites(projectId?: string | null): Promise<unknown[]>;
	createRun(input: BenchmarkRunCreateInput): Promise<BenchmarkRunCreateResult>;
	getRun(projectId: string, runId: string): Promise<unknown | null>;
	startCoordinator(runId: string): Promise<Record<string, unknown>>;
	markStatus(
		runId: string,
		status: BenchmarkRunStatusInput,
		extra?: Record<string, unknown>,
		options?: { terminalCleanup?: "sync" | "background" },
	): Promise<unknown | null>;
	recomputeSummary(runId: string): Promise<unknown>;
	retryTerminalCleanup(projectId: string, runId: string): Promise<unknown | null>;
	retryTerminalCleanupByRunId(runId: string): Promise<unknown | null>;
	scheduleTerminalCleanupByRunId(runId: string): Promise<unknown | null>;
	buildPredictionsJsonl(projectId: string, runId: string): Promise<string | null>;
	loadTraceBundle(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		options?: BenchmarkTraceBundleQueryOptions;
	}): Promise<unknown | null>;
	applyPreflight(input: {
		runId: string;
		inferenceEnvironmentsByInstanceId: Record<string, unknown>;
		preflightSummary?: Record<string, unknown> | null;
		capacitySnapshot?: Record<string, unknown> | null;
	}): Promise<unknown | null>;
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
	}): Promise<unknown | null>;
	syncInstanceFromExecution(input: {
		runId: string;
		instanceId: string;
	}): Promise<unknown | null>;
	markInstanceInferenceFailure(input: {
		runId: string;
		instanceId: string;
		status: "error" | "timeout" | "cancelled";
		error?: string | null;
		terminationReason?: string | null;
	}): Promise<unknown | null>;
	upsertDatasetArtifact(runId: string, path: string): Promise<void>;
	buildDatasetJsonlByRunId(runId: string): Promise<string>;
	upsertPredictionsArtifact(runId: string, path: string): Promise<void>;
	leaseSnapshot(runId?: string | null): Promise<unknown>;
	acquireLeases(input: {
		runId: string;
		instanceId?: string | null;
		phase?: string | null;
		resources?: BenchmarkResourceLeaseTypeInput[] | null;
		leaseSeconds?: number | null;
		metadata?: Record<string, unknown> | null;
	}): Promise<Record<string, unknown>>;
	releaseLeases(input: {
		runId: string;
		instanceId?: string | null;
		holderId?: string | null;
		phase?: string | null;
		resources?: BenchmarkResourceLeaseTypeInput[] | null;
		reason?: string | null;
	}): Promise<Record<string, unknown>>;
};

export class ApplicationBenchmarkRouteOperationsService {
	constructor(private readonly operations: BenchmarkRouteOperationsPort) {}

	listSuites(projectId?: string | null) {
		return this.operations.listSuites(projectId);
	}

	createRun(input: BenchmarkRunCreateInput) {
		return this.operations.createRun(input);
	}

	getRun(projectId: string, runId: string) {
		return this.operations.getRun(projectId, runId);
	}

	startCoordinator(runId: string) {
		return this.operations.startCoordinator(runId);
	}

	markStatus(
		runId: string,
		status: BenchmarkRunStatusInput,
		extra: Record<string, unknown> = {},
		options: { terminalCleanup?: "sync" | "background" } = {},
	) {
		return this.operations.markStatus(runId, status, extra, options);
	}

	recomputeSummary(runId: string) {
		return this.operations.recomputeSummary(runId);
	}

	retryTerminalCleanup(projectId: string, runId: string) {
		return this.operations.retryTerminalCleanup(projectId, runId);
	}

	retryTerminalCleanupByRunId(runId: string) {
		return this.operations.retryTerminalCleanupByRunId(runId);
	}

	scheduleTerminalCleanupByRunId(runId: string) {
		return this.operations.scheduleTerminalCleanupByRunId(runId);
	}

	buildPredictionsJsonl(projectId: string, runId: string) {
		return this.operations.buildPredictionsJsonl(projectId, runId);
	}

	loadTraceBundle(input: Parameters<BenchmarkRouteOperationsPort["loadTraceBundle"]>[0]) {
		return this.operations.loadTraceBundle(input);
	}

	applyPreflight(input: Parameters<BenchmarkRouteOperationsPort["applyPreflight"]>[0]) {
		return this.operations.applyPreflight(input);
	}

	applyInstanceHostExecutionUpdate(
		input: Parameters<BenchmarkRouteOperationsPort["applyInstanceHostExecutionUpdate"]>[0],
	) {
		return this.operations.applyInstanceHostExecutionUpdate(input);
	}

	syncInstanceFromExecution(
		input: Parameters<BenchmarkRouteOperationsPort["syncInstanceFromExecution"]>[0],
	) {
		return this.operations.syncInstanceFromExecution(input);
	}

	markInstanceInferenceFailure(
		input: Parameters<BenchmarkRouteOperationsPort["markInstanceInferenceFailure"]>[0],
	) {
		return this.operations.markInstanceInferenceFailure(input);
	}

	upsertDatasetArtifact(runId: string, path: string) {
		return this.operations.upsertDatasetArtifact(runId, path);
	}

	buildDatasetJsonlByRunId(runId: string) {
		return this.operations.buildDatasetJsonlByRunId(runId);
	}

	upsertPredictionsArtifact(runId: string, path: string) {
		return this.operations.upsertPredictionsArtifact(runId, path);
	}

	leaseSnapshot(runId?: string | null) {
		return this.operations.leaseSnapshot(runId);
	}

	acquireLeases(input: Parameters<BenchmarkRouteOperationsPort["acquireLeases"]>[0]) {
		return this.operations.acquireLeases(input);
	}

	releaseLeases(input: Parameters<BenchmarkRouteOperationsPort["releaseLeases"]>[0]) {
		return this.operations.releaseLeases(input);
	}
}
