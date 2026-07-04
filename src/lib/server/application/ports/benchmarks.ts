import type {
	DevPreviewInfo,
	ProvisionDevPreviewParams,
	TeardownDevPreviewParams,
	TeardownDevPreviewResult,
} from "$lib/server/workflows/dev-preview";
import type {
	BenchmarkInstanceRow,
	RepoFacet,
	RunnableAgent,
	SuiteFacet,
} from "$lib/types/benchmark-instance";
import type {
	EvaluationDatasetRowRecord,
} from "./evaluations";

export type StartBenchmarkInstanceWorkflowInput = {
	runId: string;
	instanceId: string;
};

export type StartBenchmarkInstanceWorkflowResult = Record<string, unknown>;

export type TerminateBenchmarkRunInstanceInput = {
	projectId?: string | null;
	runId: string;
	instanceId: string;
	reason: string;
};

export type TerminateBenchmarkRunInstanceResult = {
	cleanupConfirmed: boolean;
} & Record<string, unknown>;

export interface BenchmarkInstanceLifecyclePort {
	startBenchmarkInstanceWorkflow(
		input: StartBenchmarkInstanceWorkflowInput,
	): Promise<StartBenchmarkInstanceWorkflowResult>;
	terminateBenchmarkRunInstance(
		input: TerminateBenchmarkRunInstanceInput,
	): Promise<TerminateBenchmarkRunInstanceResult | null>;
}

export type BenchmarkBrowserInstanceRecord = {
	id: string;
	instanceId: string;
	repo: string | null;
	baseCommit: string | null;
	problemStatement: string | null;
	hintsText: string | null;
	testMetadata: Record<string, unknown>;
	suiteSlug: string;
	suiteName: string;
	datasetName: string;
};

export type BenchmarkBrowserRepoFacetRecord = {
	repo: string | null;
	count: number;
};

export type BenchmarkBrowserSuiteRecord = {
	id: string;
	slug: string;
	name: string;
};

export type BenchmarkBrowserEnvironmentBuildRecord = {
	envSpecHash: string | null;
	environmentKey: string | null;
	status: "queued" | "building" | "validated" | "failed" | "cancelled";
	validationStatus: string | null;
	sandboxImage: string | null;
	digest: string | null;
};

export type BenchmarkBrowserAgentRecord = {
	id: string;
	slug: string;
	name: string;
	avatar: string | null;
	runtime: string;
	registryStatus: string | null;
	currentVersionId: string | null;
	runtimeAppId: string | null;
	versionNumber: number | null;
	config: Record<string, unknown> | null;
};

export type BenchmarkBrowserReadModel = {
	instances: BenchmarkInstanceRow[];
	repoFacets: RepoFacet[];
	suiteFacets: SuiteFacet[];
	runnableAgents: RunnableAgent[];
};

export type BenchmarkRunSummaryReadModel = {
	id: string;
	suiteId: string;
	suiteSlug: string;
	suiteName: string;
	datasetName: string;
	agentId: string;
	agentName: string;
	agentSlug: string | null;
	agentVersion: number;
	agentRuntimeAppId: string | null;
	status: string;
	modelNameOrPath: string;
	modelConfigLabel: string | null;
	selectedInstanceIds: string[];
	concurrency: number;
	evaluationConcurrency: number;
	timeoutSeconds: number;
	maxTurns: number | null;
	evaluatorResourceClass: string;
	coordinatorExecutionId: string | null;
	evaluatorJobName: string | null;
	predictionsPath: string | null;
	mlflowExperimentId: string | null;
	mlflowRunId: string | null;
	mlflowDatasetId: string | null;
	mlflowEvalRunId: string | null;
	mlflowTraceExperimentName: string | null;
	mlflowUrl: string | null;
	summary: Record<string, unknown> | null;
	tags: string[];
	error: string | null;
	cancelRequestedAt: string | null;
	startedAt: string | null;
	completedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

export type BenchmarkRunsPageReadModel = {
	runs: BenchmarkRunSummaryReadModel[];
	suiteOptions: Array<{ slug: string; name: string; count: number }>;
	agentOptions: Array<{
		id: string;
		name: string;
		slug: string | null;
		count: number;
	}>;
	modelOptions: Array<{ model: string; count: number }>;
	tagOptions: Array<{ tag: string; count: number }>;
};

export type BenchmarkCompareAxisName =
	| "agent"
	| "agentVersion"
	| "model"
	| "modelLabel"
	| "mcpServerNames"
	| "skillNames"
	| "hookNames"
	| "pluginNames"
	| "maxTurns"
	| "concurrency"
	| "evaluationConcurrency"
	| "evaluatorResourceClass";

export type BenchmarkCompareRunSummary = {
	runId: string;
	suiteSlug: string;
	suiteName: string;
	createdAt: string;
	agent: { id: string; slug: string | null; name: string };
	agentVersion: number;
	model: string;
	modelLabel: string | null;
	mcpServerNames: string[];
	skillNames: string[];
	hookNames: string[];
	pluginNames: string[];
	maxTurns: number | null;
	concurrency: number;
	evaluationConcurrency: number;
	evaluatorResourceClass: string;
	resolved: number;
	total: number;
	resolvedRate: number;
	status: string;
};

export type BenchmarkCompareAxisDiff = Record<
	BenchmarkCompareAxisName,
	{
		differs: boolean;
		values: unknown[];
	}
>;

export type BenchmarkCompareInstanceCell = {
	status: string;
	resolved: boolean;
	durationMs: number | null;
	tokens: number | null;
	error: string | null;
	sessionId: string | null;
};

export type BenchmarkRegressionMetric =
	| "resolved_rate"
	| "cost_per_resolved"
	| "turn_count_p50"
	| "tokens_p50"
	| "ttft_p50"
	| "tool_call_count_p50";

export type BenchmarkMetricRegressionReadModel = {
	metric: BenchmarkRegressionMetric;
	kind: "fisher_exact" | "welch_t";
	baseline: { mean: number; n: number; ci95: [number, number] | null };
	candidate: { mean: number; n: number; ci95: [number, number] | null };
	delta: number;
	pValue: number;
	significant: boolean;
	direction: "better" | "worse" | "neutral";
};

export type BenchmarkCompareReadModel = {
	runs: BenchmarkCompareRunSummary[];
	axisDiff: BenchmarkCompareAxisDiff;
	grid: Record<string, Record<string, BenchmarkCompareInstanceCell>>;
	allInstanceIds: string[];
	sharedInstanceIds: string[];
	disagreements: string[];
	regression: BenchmarkMetricRegressionReadModel[][];
};

export type BenchmarkComparePageReadModel = {
	compare: BenchmarkCompareReadModel | null;
	runIds: string[];
	resolvedFromTag: string | null;
};

export type BenchmarkInstanceDetailReadModel = {
	id: string;
	instanceId: string;
	repo: string | null;
	baseCommit: string | null;
	problemStatement: string | null;
	hintsText: string | null;
	testMetadata: Record<string, unknown>;
	goldPatch: string | null;
	metadata: Record<string, unknown> | null;
	suiteSlug: string;
	suiteName: string;
};

export interface BenchmarkInstanceDetailReadRepository {
	getBenchmarkInstanceDetail(input: {
		suiteSlug: string;
		instanceId: string;
	}): Promise<BenchmarkInstanceDetailReadModel | null>;
}

export type BenchmarkRunInstanceScoreReadModel = {
	id: string;
	scorerName: string;
	scorerVersion: number;
	score: number;
	reasoning: string | null;
	metadata: Record<string, unknown>;
	createdAt: Date;
};

export type BenchmarkRunInstanceScoresReadModel =
	| { status: "run_not_found" }
	| { status: "instance_not_found" }
	| { status: "ok"; scores: BenchmarkRunInstanceScoreReadModel[] };

export interface BenchmarkRunInstanceScoreReadRepository {
	listRunInstanceScores(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}): Promise<BenchmarkRunInstanceScoresReadModel>;
}

export type BenchmarkRunInstanceDetailRunRecord = {
	[key: string]: unknown;
	id: string;
	runId: string;
	instanceId: string;
	evaluationStatus: string;
	evaluatedAt: Date | null;
	harnessResult: unknown;
	mlflowRunId: string | null;
	traceIds: string[] | null;
};

export type BenchmarkRunInstanceDetailBenchmarkRecord = {
	repo: string | null;
	baseCommit: string | null;
	problemStatement: string | null;
	hintsText: string | null;
	testMetadata: Record<string, unknown>;
	metadata: Record<string, unknown> | null;
	goldPatch: string | null;
};

export type BenchmarkRunInstanceDetailReadModel =
	| { status: "run_not_found" }
	| { status: "instance_not_found" }
	| {
			status: "ok";
			mlflowExperimentId: string | null;
			runInstance: BenchmarkRunInstanceDetailRunRecord;
			instance: BenchmarkRunInstanceDetailBenchmarkRecord;
			executionIr: unknown;
			executionOutput: unknown;
	  };

export interface BenchmarkRunInstanceDetailReadRepository {
	getRunInstanceDetail(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}): Promise<BenchmarkRunInstanceDetailReadModel>;
}

export type BenchmarkInstanceAnnotationVerdict =
	| "correct"
	| "incorrect"
	| "partial"
	| "unsure";

export type BenchmarkArtifactKind =
	| "dataset_jsonl"
	| "predictions_jsonl"
	| "model_patch"
	| "harness_result"
	| "logs"
	| "test_output";

export type BenchmarkArtifactMetadataInput = {
	runId: string;
	instanceId: string | null;
	kind: BenchmarkArtifactKind;
	path: string;
	contentType: string | null;
	sizeBytes: number;
	sha256: string;
	metadata: Record<string, unknown>;
};

export interface BenchmarkArtifactMetadataRepository {
	recordArtifact(input: BenchmarkArtifactMetadataInput): Promise<void>;
}

export type BenchmarkEvaluationRunStatus =
	| "queued"
	| "inferencing"
	| "evaluating"
	| "completed"
	| "failed"
	| "cancelled";

export type BenchmarkEvaluationRunInstanceStatus =
	| "queued"
	| "inferencing"
	| "inferred"
	| "evaluating"
	| "resolved"
	| "failed"
	| "error"
	| "timeout"
	| "cancelled";

export type BenchmarkEvaluationStatus =
	| "pending"
	| "evaluating"
	| "resolved"
	| "unresolved"
	| "empty_patch"
	| "error"
	| "timeout";

export type BenchmarkEvaluationRunRecord = Record<string, unknown> & {
	id: string;
	status: BenchmarkEvaluationRunStatus;
	summary?: Record<string, unknown> | null;
};

export type BenchmarkEvaluationResultInput = {
	instance_id?: string;
	instanceId?: string;
	resolved?: boolean;
	status?: string;
	error?: string;
	logs_path?: string;
	logsPath?: string;
	test_output_summary?: string;
	testOutputSummary?: string;
	harness_result?: Record<string, unknown>;
	harnessResult?: Record<string, unknown>;
};

export type BenchmarkEvaluationPatchContext = {
	modelPatch: string | null;
	goldPatch: string | null;
};

export type BenchmarkEvaluationResultUpdate = {
	instanceId: string;
	status: BenchmarkEvaluationRunInstanceStatus;
	evaluationStatus: BenchmarkEvaluationStatus;
	error: string | null;
	evaluationError: string | null;
	logsPath: string | null;
	testOutputSummary: string | null;
	harnessResult: Record<string, unknown> | null;
	patchAddedLines: number | null;
	patchRemovedLines: number | null;
	patchFilesTouched: number | null;
	patchFilesOverlapGold: number | null;
	patchWellFormed: boolean | null;
};

export type BenchmarkEvaluationResultsCallbackInput = {
	runId: string;
	results?: BenchmarkEvaluationResultInput[];
	error?: string | null;
	jobName?: string | null;
	receivedAt?: Date;
};

export type BenchmarkEvaluationIngestResult =
	| { status: "run_not_found" }
	| { status: "skipped"; run: BenchmarkEvaluationRunRecord }
	| {
			status: "ok";
			run?: BenchmarkEvaluationRunRecord | null;
			summary?: Record<string, unknown> | null;
			updatedInstanceIds?: string[];
	  };

export interface BenchmarkEvaluationResultRepository {
	getRunForEvaluationIngestion(
		runId: string,
	): Promise<BenchmarkEvaluationRunRecord | null>;
	loadPatchContexts(
		runId: string,
	): Promise<Map<string, BenchmarkEvaluationPatchContext>>;
	batchUpdateEvaluationResults(input: {
		runId: string;
		updates: BenchmarkEvaluationResultUpdate[];
		evaluatedAt: Date;
	}): Promise<void>;
	countActiveEvaluationRows(runId: string): Promise<number>;
	getRunForResponse(runId: string): Promise<BenchmarkEvaluationRunRecord | null>;
}

export interface BenchmarkRunLifecyclePort {
	markStatus(
		runId: string,
		status: BenchmarkEvaluationRunStatus,
		extra?: Record<string, unknown>,
		options?: { terminalCleanup?: "background" | "sync" },
	): Promise<BenchmarkEvaluationRunRecord | null>;
	recomputeSummary(runId: string): Promise<Record<string, unknown>>;
}

export interface BenchmarkRunCancellationPort {
	cancelBenchmarkRun(
		projectId: string,
		runId: string,
		options?: { terminalCleanup?: "background" | "sync" },
	): Promise<unknown | null>;
}

export interface BenchmarkEvaluationTelemetryPort {
	syncEvaluationResults(input: {
		runId: string;
		instanceIds: string[];
	}): void;
}

export interface BenchmarkEvaluationEventNotifier {
	notifyEvaluationEvent(input: {
		runId: string;
		eventType: "results" | "failed";
		jobName?: string | null;
		error?: string | null;
		postedAt?: Date;
	}): Promise<void>;
}

export type BenchmarkRunInstanceAnnotationCounts = Record<
	BenchmarkInstanceAnnotationVerdict,
	number
>;

export type BenchmarkRunInstanceAnnotationsReadModel =
	| { status: "not_found" }
	| {
			status: "ok";
			mine: {
				verdict: BenchmarkInstanceAnnotationVerdict;
				reasoning: string | null;
				updatedAt: Date;
			} | null;
			counts: BenchmarkRunInstanceAnnotationCounts;
	  };

export type BenchmarkRunInstanceAnnotationCommandResult =
	| { status: "ok" }
	| { status: "not_found" };

export interface BenchmarkRunInstanceAnnotationRepository {
	getRunInstanceAnnotations(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}): Promise<BenchmarkRunInstanceAnnotationsReadModel>;
	upsertRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
		verdict: BenchmarkInstanceAnnotationVerdict;
		reasoning: string | null;
	}): Promise<BenchmarkRunInstanceAnnotationCommandResult>;
	deleteRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}): Promise<BenchmarkRunInstanceAnnotationCommandResult>;
}

export type PromoteBenchmarkRunInstanceToDatasetResult =
	| { status: "ok"; rows: EvaluationDatasetRowRecord[] }
	| { status: "benchmark_instance_not_found" }
	| { status: "run_in_different_workspace" }
	| { status: "evaluation_dataset_not_found" };

export interface BenchmarkDatasetPromotionRepository {
	promoteRunInstanceToDataset(input: {
		projectId: string;
		datasetId: string;
		runId: string;
		instanceId: string;
		now: Date;
	}): Promise<PromoteBenchmarkRunInstanceToDatasetResult>;
}

export type BenchmarkRunInstanceProgressReadModel =
	| { status: "not_found" }
	| {
			status: "ok";
			runInstanceStatus: string;
			inferenceStatus: string;
			evaluationStatus: string;
			sessionId: string | null;
			latestSessionEventType: string | null;
			latestSessionEventSequence: number | null;
			latestActivityAt: Date;
			activityAgeSeconds: number;
			progressMarker: string;
	  };

export interface BenchmarkRunInstanceProgressReadRepository {
	getRunInstanceProgress(input: {
		runId: string;
		instanceId: string;
		now: Date;
	}): Promise<BenchmarkRunInstanceProgressReadModel>;
}

export interface BenchmarkBrowserRepository {
	ensureDefaultSuites(): Promise<void>;
	listInstances(): Promise<BenchmarkBrowserInstanceRecord[]>;
	listRepoFacets(): Promise<BenchmarkBrowserRepoFacetRecord[]>;
	listSuites(): Promise<BenchmarkBrowserSuiteRecord[]>;
	listEnvironmentBuilds(): Promise<BenchmarkBrowserEnvironmentBuildRecord[]>;
	listRunnableAgentCandidates(input: {
		projectId: string | null;
	}): Promise<BenchmarkBrowserAgentRecord[]>;
}

export interface BenchmarkRunReadRepository {
	listRuns(input: {
		projectId: string;
		limit?: number;
		tag?: string | null;
	}): Promise<BenchmarkRunSummaryReadModel[]>;
	loadCompareData(input: {
		projectId: string;
		runIds: string[];
	}): Promise<BenchmarkCompareReadModel>;
}

export type BenchmarkSessionProvisioningGateRecord = {
	runStatus: string;
	summary: Record<string, unknown> | null;
	instanceStatus: string | null;
	inferenceStatus: string | null;
};

export interface BenchmarkRunRepository {
	getSessionProvisioningGate(input: {
		runId: string;
		instanceId?: string | null;
	}): Promise<BenchmarkSessionProvisioningGateRecord | null>;
	getProjectId(runId: string): Promise<string | null>;
}

export type BenchmarkSessionProvisioningGateResult =
	| {
			ok: true;
			benchmarkExecutionClass: string | null;
	  }
	| {
			ok: false;
			status: 404 | 409;
			message: string;
	  };

export type SessionControlSettingsEnvironment = {
	id: string;
	slug: string;
	version: number;
	config: Record<string, unknown>;
};

export interface PreviewEnvironmentProvisioner {
	provision(input: ProvisionDevPreviewParams): Promise<DevPreviewInfo>;
	teardown(input: TeardownDevPreviewParams): Promise<TeardownDevPreviewResult>;
}
