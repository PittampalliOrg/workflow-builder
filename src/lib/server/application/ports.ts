import type { AgentMcpResolutionResult } from "$lib/server/agents/mcp-resolution";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import type { McpServerAvailabilityEntry } from "$lib/server/mcp-catalog";
import type { AgentSkillConfig } from "$lib/agent-skill-presets";
import type {
	AgentConfig,
	AgentDetail,
	AgentRuntime,
	AgentSummary,
	AgentToolChoice,
	AgentVersionSummary,
} from "$lib/types/agents";
import type {
	SandboxProvisionInput,
	SandboxProvisionResult,
} from "$lib/server/sandboxes/provision";
import type {
	DevPreviewInfo,
	ProvisionDevPreviewParams,
} from "$lib/server/workflows/dev-preview";
import type { RuntimeConfigCloudEvent } from "$lib/server/sessions/runtime-config";
import type {
	BenchmarkInstanceRow,
	RepoFacet,
	RunnableAgent,
	SuiteFacet,
} from "$lib/types/benchmark-instance";
import type {
	SessionDetail,
	SessionEventEnvelope,
	SessionResource,
	SessionResourceType,
	SessionSummary,
	SessionStatus,
	SessionStopReason,
	SessionUsage,
	UserEvent,
} from "$lib/types/sessions";
import type {
	GoalFlow,
	ObservabilityAgentDecisionTurn,
} from "$lib/types/observability";

export type WorkflowRef = {
	workflowId?: string | null;
	workflowName?: string | null;
};

export type WorkflowVisibility = "private" | "public";
export type WorkflowEngineType = "vercel" | "dapr";

export type WorkflowDefinition = {
	id: string;
	name: string;
	description: string | null;
	userId: string;
	projectId: string | null;
	nodes: unknown[];
	edges: unknown[];
	specVersion: string | null;
	spec: unknown;
	visibility: WorkflowVisibility;
	engineType: WorkflowEngineType | null;
	daprWorkflowName: string | null;
	daprOrchestratorUrl: string | null;
	/** Legacy storage fields; do not use for new trace persistence. */
	mlflowExperimentId: string | null;
	mlflowExperimentName: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type WorkflowDefinitionListItem = Pick<
	WorkflowDefinition,
	"id" | "name" | "engineType" | "createdAt" | "updatedAt"
>;

export type WorkspaceWorkflowDefinitionSummary = Pick<
	WorkflowDefinition,
	"id" | "name" | "updatedAt"
>;

export type WorkspaceWorkflowRunSummary = {
	id: string;
	status: string;
	startedAt: string;
	completedAt: string | null;
};

export type WorkspaceWorkflowListItem = {
	id: string;
	name: string;
	updatedAt: string;
	latestExecution: WorkspaceWorkflowRunSummary | null;
	recentRuns: WorkspaceWorkflowRunSummary[];
	running: boolean;
	lastActivityAt: string;
	forkCount: number;
};

export type ServiceGraphWorkflowOption = {
	id: string;
	name: string;
};

export type ServiceGraphExecutionOption = {
	id: string;
	label: string;
	workflowId: string | null;
};

export type ServiceGraphPickerOptions = {
	workflows: ServiceGraphWorkflowOption[];
	executions: ServiceGraphExecutionOption[];
	defaultExecutionId: string;
};

export type AgentRuntimeAgentRecord = {
	id: string;
	projectId: string | null;
	slug: string;
	runtimeAppId: string | null;
	isArchived: boolean;
};

export interface AgentRuntimeRepository {
	listProjectAgents(projectId: string): Promise<AgentRuntimeAgentRecord[]>;
	getAgentBySlug(input: {
		slug: string;
		projectId?: string | null;
	}): Promise<AgentRuntimeAgentRecord | null>;
	listRecentlyActiveAgentSlugs(input: {
		slugs: string[];
		activeStatuses: string[];
		updatedAfter: Date;
	}): Promise<string[]>;
}

export type AgentRuntimeWarmPoolRecord = {
	name: string;
	namespace: string;
	labels: Record<string, string>;
	annotations: Record<string, string>;
	desiredReplicas: number;
	replicas: number;
	readyReplicas: number;
	sandboxTemplateRefName: string;
};

export type AgentRuntimePodContainerReadiness = {
	name: string;
	ready: boolean;
};

export type AgentRuntimePodRecord = {
	name: string;
	namespace: string;
	containers: AgentRuntimePodContainerReadiness[];
};

export type AgentRuntimeWakeResult = {
	phase: string;
	replicas: number;
	readyReplicas: number;
	source: string;
};

export interface AgentRuntimeWarmPoolClient {
	listWarmPools(namespace?: string): Promise<AgentRuntimeWarmPoolRecord[]>;
	getWarmPool(
		name: string,
		namespace?: string,
	): Promise<AgentRuntimeWarmPoolRecord | null>;
	getRuntimePod(
		runtimeSlug: string,
		namespace?: string,
	): Promise<AgentRuntimePodRecord | null>;
	wakeRuntime(
		runtimeSlug: string,
		timeoutMs: number,
		namespace?: string,
	): Promise<AgentRuntimeWakeResult>;
	sleepRuntime(runtimeSlug: string, namespace?: string): Promise<void>;
	setWarmPoolReplicas(
		name: string,
		replicas: number,
		namespace?: string,
	): Promise<void>;
}

export type PieceMetadataDetailRecord = {
	name: string;
	displayName: string;
	description: string | null;
	logoUrl: string | null;
	categories: string[];
	version: string;
	auth: unknown;
	actions: unknown;
	availableOnly: boolean;
	catalogSourceImage: string | null;
	catalogSyncedAt: Date | null;
	updatedAt: Date | null;
};

export type PieceConnectionUsageRecord = {
	connectionExternalId: string;
	refCount: number;
	workflowCount: number;
};

export type PieceCatalogDetail = {
	piece: PieceMetadataDetailRecord | null;
	usageByConnection: Record<
		string,
		{
			refCount: number;
			workflowCount: number;
		}
	>;
};

export type PieceConnectionDetailPageReadModel = {
	piece: {
		pieceName: string;
		canonicalPieceName: string;
		displayName: string;
		description: string | null;
		logoUrl: string | null;
		categories: string[];
		version: string;
		authType: string;
		authDisplayName: string | null;
		requiresAuth: boolean;
		isOAuth2: boolean;
		availableOnly: boolean;
		catalogSourceImage: string | null;
		catalogSyncedAt: string | null;
		metadataUpdatedAt: string | null;
	};
	actions: McpCatalogPieceAction[];
	usageByConnection: PieceCatalogDetail["usageByConnection"];
};

export type ConnectablePieceRecord = {
	name: string;
	displayName: string | null;
	logoUrl: string | null;
	authType: string | null;
};

export type ConnectablePieceReadModel = {
	name: string;
	displayName: string | null;
	logoUrl: string | null;
	authType: string | null;
};

export type CatalogFunctionSummary = {
	name: string;
	version: string;
	displayName: string;
	description: string;
	pieceName: string;
	actionName: string;
	providerId?: string;
	providerLabel?: string;
	providerIconUrl?: string | null;
	category?: string | null;
	entrypoint?: string;
	sourceKind?: "code";
	codeFunctionId?: string;
	language?: string;
};

export type CodeCatalogFunctionRecord = {
	id: string;
	name: string;
	slug: string;
	description: string | null;
	version: string;
	latestPublishedVersion: string | null;
	entrypoint: string;
	language: string;
};

export type CatalogFunctionsReadModel = {
	functions: CatalogFunctionSummary[];
	count: number;
	error: string | null;
};

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

export type ObservabilityServiceGraphWorkflowReadModel = {
	id: string;
	nodes: unknown[];
	edges: unknown[];
};

export type ObservabilityServiceGraphContextReadModel = {
	execution: WorkflowExecutionRecord | null;
	workflow: ObservabilityServiceGraphWorkflowReadModel | null;
	targetWorkflowId: string | null;
};

export type WorkflowActivityRateTargetReadModel = {
	executionId: string;
	sessionId: string;
	daprAppId: string;
};

export interface WorkflowActivityRateTargetRepository {
	resolveWorkflowActivityRateTarget(input: {
		executionId: string;
	}): Promise<WorkflowActivityRateTargetReadModel | null>;
}

export type ObservabilityTraceScopeReadModel = {
	sessionIds: string[];
	executionIds: string[];
	sessionIdFilter: string | null;
};

export type ObservabilityTraceGoalVerdict =
	| "pass"
	| "active"
	| "limited"
	| "paused";

export type ObservabilityTraceGoalChipReadModel = {
	sessionId: string;
	status: string;
	iterations: number;
	verdict: ObservabilityTraceGoalVerdict;
};

export interface ObservabilityTraceRepository {
	getTraceScope(input: {
		userId: string;
		projectId?: string | null;
		sessionIdFilter?: string | null;
		sessionLimit?: number;
		executionLimit?: number;
	}): Promise<ObservabilityTraceScopeReadModel | null>;
	listTraceGoalChips(input: {
		sessionIds: string[];
	}): Promise<ObservabilityTraceGoalChipReadModel[]>;
}

export type WorkflowMonitorFallbackExecutionReadModel = {
	id: string;
	instanceId: string | null;
	workflowId: string | null;
	workflowName: string | null;
	status: WorkflowExecutionStatus;
	phase: string | null;
	progress: number | null;
	startedAt: Date | null;
	completedAt: Date | null;
	duration: string | number | null;
};

export interface WorkflowMonitorReadRepository {
	listFallbackExecutions(input: {
		limit: number;
	}): Promise<WorkflowMonitorFallbackExecutionReadModel[]>;
}

export type PromptPresetUsageBindingKind = "static" | "dynamic";

export type PromptPresetAgentUsageReadModel = {
	id: string;
	slug: string;
	name: string;
	bindingKind: PromptPresetUsageBindingKind;
	version: number;
	latestVersion: number;
	isStale: boolean;
};

export type PromptPresetUsagesReadModel = {
	usages: PromptPresetAgentUsageReadModel[];
	latestVersion: number;
};

export type AgentSkillUsedByAgentReadModel = {
	id: string;
	slug: string;
	name: string;
	projectId: string | null;
	runtimeAppId: string | null;
	registryStatus: string | null;
};

export type AgentSkillUsedByReadModel = {
	agents: AgentSkillUsedByAgentReadModel[];
	truncated: boolean;
	total: number;
};

export type VaultUsageAgentReadModel = {
	id: string;
	slug: string;
	name: string;
	avatar: string | null;
	isArchived: boolean;
};

export type VaultUsagesReadModel = {
	agents: VaultUsageAgentReadModel[];
	sessionCount: number;
};

export interface ResourceUsageReadRepository {
	getPromptPresetUsages(input: {
		presetId: string;
		projectId: string;
	}): Promise<PromptPresetUsagesReadModel | null>;
	listAgentSkillUsedBy(input: {
		skillRef: string;
		projectId?: string | null;
		limit: number;
	}): Promise<AgentSkillUsedByReadModel | null>;
	getVaultUsages(input: {
		vaultId: string;
	}): Promise<VaultUsagesReadModel>;
}

export type WorkflowAiAssistantMessageRole = "user" | "assistant" | "system";

export type WorkflowAiAssistantMessageReadModel = {
	id: string;
	role: WorkflowAiAssistantMessageRole;
	content: string;
	operations: Array<Record<string, unknown>> | null;
	createdAt: Date;
};

export interface WorkflowAiAssistantMessageRepository {
	listMessages(input: {
		workflowId: string;
		userId: string;
		limit: number;
	}): Promise<WorkflowAiAssistantMessageReadModel[]>;
	deleteMessages(input: {
		workflowId: string;
		userId: string;
	}): Promise<void>;
}

export type SecurityAuditEventKind =
	| "credential.access"
	| "member.added"
	| "config.change";

export type SecurityAuditEventReadModel = {
	id: string;
	at: string;
	kind: SecurityAuditEventKind;
	summary: string;
	executionId?: string | null;
	actor?: string | null;
};

export type SecurityAuditReadModel = {
	events: SecurityAuditEventReadModel[];
	asOf: string;
};

export interface SecurityAuditReadRepository {
	getSecurityAudit(input: {
		projectId?: string | null;
		since: Date;
		now: Date;
		limit: number;
	}): Promise<SecurityAuditReadModel>;
}

export type DashboardStatsReadModel = {
	activeSessions: number;
	sessionsToday: number;
	archivedLast24h: number;
	tokensOut7d: number;
	tokensIn7d: number;
	totalAgents: number;
	totalEnvironments: number;
	totalVaults: number;
};

export type DashboardActiveSessionReadModel = {
	id: string;
	title: string | null;
	status: string;
	agentId: string;
	agentName: string;
	agentAvatar: string | null;
	updatedAt: string;
	createdAt: string;
};

export type DashboardRecentChangeReadModel = {
	kind: "agent" | "environment";
	resourceId: string;
	resourceName: string;
	version: number;
	publishedAt: string | null;
};

export type DashboardReadModel = {
	stats: DashboardStatsReadModel;
	activeSessions: DashboardActiveSessionReadModel[];
	recentChanges: DashboardRecentChangeReadModel[];
};

export interface DashboardReadRepository {
	getDashboard(input: {
		userId: string;
		now: Date;
	}): Promise<DashboardReadModel>;
}

export type HomePageUserReadModel = {
	name: string | null;
	email: string | null;
};

export type HomePageRecentSessionReadModel = {
	id: string;
	title: string | null;
	status: string;
	agentId: string;
	updatedAt: string;
};

export type HomePageRecentRunReadModel = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: string;
	startedAt: string;
	durationMs: number | null;
};

export type HomePageReadModel = {
	user: HomePageUserReadModel | null;
	recentSessions: HomePageRecentSessionReadModel[];
	recentRuns: HomePageRecentRunReadModel[];
};

export type HomePageRecentSessionRecord = {
	id: string;
	title: string | null;
	status: string;
	agentId: string;
	updatedAt: Date;
};

export type HomePageRecentRunRecord = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: string;
	startedAt: Date;
	duration: string | null;
};

export interface HomePageReadRepository {
	listRecentHomeSessions(input: {
		userId: string;
		projectId?: string | null;
		limit: number;
	}): Promise<HomePageRecentSessionRecord[]>;
	listRecentHomeRuns(input: {
		projectId: string;
		limit: number;
	}): Promise<HomePageRecentRunRecord[]>;
}

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

export interface EvaluationRunCancellationPort {
	cancelEvaluationRun(projectId: string, runId: string): Promise<unknown>;
}

export interface LifecycleCoordinatorCancelNotifier {
	scheduleCoordinatorCancel(kind: "benchmarkRun" | "evalRun", runId: string): void;
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

export type EvaluationDatasetRowRecord = {
	id: string;
	datasetId: string;
	externalId: string | null;
	input: Record<string, unknown>;
	expectedOutput: unknown;
	generatedOutput: unknown;
	annotations: Record<string, unknown>;
	rating: number | null;
	feedback: string | null;
	metadata: Record<string, unknown>;
	originRunInstanceId: string | null;
	originSessionId: string | null;
	createdAt: Date;
	updatedAt: Date;
};

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

export type CreateWorkflowDefinitionInput = {
	name: string;
	nodes: unknown[];
	edges: unknown[];
	engineType: WorkflowEngineType;
	userId: string;
	projectId: string;
	spec?: unknown;
};

export type UpdateWorkflowDefinitionInput = {
	name?: string;
	nodes?: unknown[];
	edges?: unknown[];
	spec?: unknown;
	daprWorkflowName?: string;
};

export interface WorkflowConnectionRefSyncPort {
	syncWorkflowConnectionRefs(input: {
		workflowId: string;
		nodes: unknown;
		spec?: unknown;
	}): Promise<void>;
}

export type WorkflowTriggerStatus =
	| "inactive"
	| "activating"
	| "active"
	| "deactivating"
	| "error";

export type WorkflowTriggerRecord = {
	id: string;
	workflowId: string;
	userId: string;
	projectId: string | null;
	kind: string;
	config: Record<string, unknown>;
	triggerData: Record<string, unknown> | null;
	dedupSalt: string;
	backingRef: string | null;
	status: WorkflowTriggerStatus;
	lastError: string | null;
	lastFiredAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export type CreateWorkflowTriggerInput = {
	workflowId: string;
	userId: string;
	projectId: string | null;
	kind: string;
	config: Record<string, unknown>;
	triggerData?: Record<string, unknown> | null;
	dedupSalt: string;
	status?: WorkflowTriggerStatus;
};

export interface WorkflowTriggerStore {
	listByWorkflowId(workflowId: string): Promise<WorkflowTriggerRecord[]>;
	create(input: CreateWorkflowTriggerInput): Promise<WorkflowTriggerRecord>;
	getById(triggerId: string): Promise<WorkflowTriggerRecord | null>;
	getForWorkflow(input: {
		workflowId: string;
		triggerId: string;
	}): Promise<WorkflowTriggerRecord | null>;
	markFired(input: { triggerId: string; firedAt: Date }): Promise<void>;
	delete(triggerId: string): Promise<void>;
}

export type WorkflowTriggerLifecycleActionResult =
	| { ok: true; status: string }
	| { ok: false; error: string };

export interface WorkflowTriggerLifecyclePort {
	activateTrigger(triggerId: string): Promise<WorkflowTriggerLifecycleActionResult>;
	deactivateTrigger(triggerId: string): Promise<WorkflowTriggerLifecycleActionResult>;
}

export type PieceExecutionStatus = "running" | "paused" | "completed" | "failed";

export type PieceExecutionReadModel = {
	idempotencyKey: string;
	status: PieceExecutionStatus;
	result: unknown;
	error: string | null;
	pieceName: string;
	actionName: string;
	completedAt: Date | null;
};

export interface PieceExecutionRepository {
	getByIdempotencyKey(idempotencyKey: string): Promise<PieceExecutionReadModel | null>;
}

export type WorkflowBrowserArtifactStatus = "pending" | "completed" | "partial" | "failed";

export type WorkflowBrowserCaptureStepInput = {
	id?: string;
	label?: string;
	url?: string;
	action?: string;
	goal?: string;
	title?: string;
	waitForSelector?: string;
	waitForText?: string;
	delayMs?: number;
	pauseMs?: number;
	successCriteria?: string;
	capturedAt?: string;
	status?: "completed" | "failed";
	screenshotStorageRef?: string;
	error?: string;
};

export type WorkflowBrowserArtifactAssetInput = {
	kind: "screenshot" | "trace" | "video" | "video-annotated" | "caption";
	label: string;
	payloadBase64: string;
	contentType?: string;
	fileName?: string;
	stepId?: string;
	storageRef?: string;
};

export type SaveWorkflowBrowserArtifactInput = {
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef?: string | null;
	baseUrl: string;
	status: WorkflowBrowserArtifactStatus;
	metadata?: Record<string, unknown> | null;
	steps: WorkflowBrowserCaptureStepInput[];
	screenshots?: Omit<WorkflowBrowserArtifactAssetInput, "kind">[];
	assets?: WorkflowBrowserArtifactAssetInput[];
};

export type WorkflowBrowserArtifactRecord = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	workspaceRef: string | null;
	artifactType: "capture_flow_v1";
	artifactVersion: number;
	status: WorkflowBrowserArtifactStatus;
	manifestJson: Record<string, unknown>;
	createdAt: Date;
	updatedAt: Date;
};

export type WorkflowBrowserBlobPayload = {
	payloadBase64: string;
	contentType: string;
};

export interface WorkflowBrowserArtifactStore {
	save(input: SaveWorkflowBrowserArtifactInput): Promise<WorkflowBrowserArtifactRecord>;
	listByExecutionId(workflowExecutionId: string): Promise<WorkflowBrowserArtifactRecord[]>;
	getBlobPayload(storageRef: string): Promise<WorkflowBrowserBlobPayload | null>;
}

export type ApiKeyRecord = {
	id: string;
	userId: string;
};

export type UserApiKeyListItem = {
	id: string;
	name: string | null;
	keyPrefix: string;
	createdAt: Date;
	lastUsedAt: Date | null;
};

export type CreateUserApiKeySecretInput = {
	id: string;
	userId: string;
	name: string;
	keyHash: string;
	keyPrefix: string;
};

export type UpdateUserApiKeySecretInput = {
	id: string;
	userId: string;
	keyHash: string;
	keyPrefix: string;
};

export type UserApiKeyWithPlaintext = Omit<UserApiKeyListItem, "lastUsedAt"> & {
	key: string;
};

export type UserProfileRecord = {
	name: string | null;
	email: string | null;
	image: string | null;
	platformRole: "ADMIN" | "MEMBER";
};

export type SettingsUserProfileRecord = {
	id: string;
	name: string | null;
	email: string | null;
	image: string | null;
	platformId: string | null;
	platformRole: string | null;
};

export type SettingsPlatformOAuthAppRecord = {
	id: string;
	pieceName: string;
	clientId: string;
	createdAt: Date;
	updatedAt: Date;
};

export type SettingsOAuthPieceRecord = {
	name: string;
	displayName: string;
	logoUrl: string | null;
};

export type SettingsOAuthAppListItem = {
	id: string | null;
	pieceName: string;
	clientId: string;
	displayName: string;
	logoUrl: string | null;
	configured: boolean;
	createdAt: Date | null;
	updatedAt: Date | null;
};

export type SavePlatformOAuthAppInput = {
	id?: string | null;
	sessionPlatformId?: string | null;
	pieceName: string;
	clientId: string;
	clientSecret?: string | null;
};

export type PlatformOAuthAppMutationRecord = {
	id: string;
	platformId: string;
	pieceName: string;
	clientId: string;
	createdAt: Date;
	updatedAt: Date;
};

export type SettingsPageReadModel = {
	profile: SettingsUserProfileRecord | null;
	oauthApps: SettingsOAuthAppListItem[];
};

export type AdminPieceMetadataRecord = {
	name: string | null;
	displayName: string | null;
	logoUrl: string | null;
};

export type AdminPieceImageStatusRecord = {
	pieceName: string;
	status: "building" | "ready" | "failed" | string;
	image: string | null;
	errorMessage: string | null;
	enabled: boolean;
};

export type AdminProvisionedPieceRow = {
	name: string;
	displayName: string;
	logoUrl: string;
	enabled: boolean;
	inUse: boolean;
	pinned: boolean;
	perPiece: boolean;
};

export type AdminAvailablePieceRow = {
	name: string;
	displayName: string;
	logoUrl: string;
	buildStatus: "building" | "ready" | "failed" | null;
	errorMessage: string | null;
};

export type AdminPiecesReadModel = {
	pieces: AdminProvisionedPieceRow[];
	available: AdminAvailablePieceRow[];
	total: number;
	enabledCount: number;
	availableCount: number;
};

export type WorkspaceProjectMembershipDetail = {
	id: string;
	displayName: string;
	externalId: string;
	selfRole: string | null;
};

export type ProjectMemberListItem = {
	id: string;
	userId: string;
	name: string | null;
	email: string | null;
	image: string | null;
	role: ProjectMembershipRole;
	createdAt: Date;
};

export type ProjectMembersReadModel = {
	members: ProjectMemberListItem[];
	selfRole: ProjectMembershipRole;
};

export type ProjectMemberRecord = {
	id: string;
	projectId: string;
	userId: string;
	role: ProjectMembershipRole;
	createdAt: Date;
	updatedAt: Date;
};

export type ProjectMembersResult =
	| {
			ok: true;
			status: 200;
			members: ProjectMemberListItem[];
			selfRole: ProjectMembershipRole;
	  }
	| {
			ok: false;
			status: 400 | 403 | 404 | 409 | 503;
			message: string;
	  };

export type ProjectMemberCommandResult =
	| {
			ok: true;
			status: 200 | 201;
			member: ProjectMemberRecord;
	  }
	| {
			ok: false;
			status: 400 | 403 | 404 | 409 | 503;
			message: string;
	  };

export type ProjectMemberDeleteResult =
	| {
			ok: true;
			status: 200;
	  }
	| {
			ok: false;
			status: 400 | 403 | 404 | 409 | 503;
			message: string;
	  };

export type ApiKeyValidationResult =
	| { valid: true; apiKeyId: string }
	| { valid: false; error: string; statusCode: number };

export interface ApiKeyStore {
	getByKeyHash(keyHash: string): Promise<ApiKeyRecord | null>;
	markUsed(apiKeyId: string, usedAt: Date): Promise<void>;
	listByUserId(userId: string): Promise<UserApiKeyListItem[]>;
	createUserApiKey(input: CreateUserApiKeySecretInput): Promise<UserApiKeyListItem>;
	deleteForUser(input: { id: string; userId: string }): Promise<boolean>;
	updateSecretForUser(
		input: UpdateUserApiKeySecretInput,
	): Promise<UserApiKeyListItem | null>;
}

export interface UserProfileRepository {
	getUserProfile(userId: string): Promise<UserProfileRecord | null>;
}

export interface SettingsRepository {
	getSettingsUserProfile(userId: string): Promise<SettingsUserProfileRecord | null>;
	listPlatformOAuthApps(platformId: string): Promise<SettingsPlatformOAuthAppRecord[]>;
	listOAuthPieces(): Promise<SettingsOAuthPieceRecord[]>;
	resolvePlatformId(sessionPlatformId?: string | null): Promise<string>;
	savePlatformOAuthApp(input: {
		id?: string | null;
		platformId?: string | null;
		pieceName: string;
		clientId: string;
		encryptedClientSecret?: { iv: string; data: string } | null;
	}): Promise<PlatformOAuthAppMutationRecord | null>;
	deletePlatformOAuthApp(id: string): Promise<void>;
}

export type McpConnectionSourceType =
	| "nimble_piece"
	| "nimble_shared"
	| "custom_url"
	| "hosted_workflow";

export type McpConnectionStatus = "ENABLED" | "DISABLED" | "ERROR";

export type McpConnectionRecord = {
	id: string;
	projectId: string;
	sourceType: McpConnectionSourceType;
	pieceName: string | null;
	serverKey: string | null;
	connectionExternalId: string | null;
	displayName: string;
	registryRef: string | null;
	serverUrl: string | null;
	status: McpConnectionStatus;
	lastSyncAt: Date | null;
	lastError: string | null;
	metadata: Record<string, unknown> | null;
	createdBy: string | null;
	updatedBy: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export type McpConnectionCommandResult =
	| {
			ok: true;
			connection: McpConnectionRecord;
			status: 200 | 201;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type McpConnectionDeleteResult =
	| {
			ok: true;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type McpConnectionToolDiscoveryResult =
	| {
			ok: true;
			toolNames: string[];
			source: "metadata" | "health" | "none";
	  }
	| {
			ok: false;
			status: 404 | 500 | 502;
			message: string;
	  };

export type McpCatalogPieceAction = {
	name: string;
	displayName: string;
	description: string | null;
};

export type McpCatalogPieceActionsResult =
	| {
			ok: true;
			pieceName: string;
			actions: McpCatalogPieceAction[];
	  }
	| {
			ok: false;
			status: 404;
			message: string;
	  };

export type McpCatalogPieceRecord = {
	name: string;
	displayName: string;
	description: string | null;
	logoUrl: string | null;
	categories: string[];
	auth: unknown;
	actions: unknown;
	availableOnly: boolean;
	updatedAt: Date | null;
};

export type McpCatalogAppConnectionSummary = {
	id: string;
	externalId: string;
	displayName: string;
	pieceName: string;
	type: string;
	status: string;
};

export type McpCatalogConfiguredConnectionSummary = {
	id: string;
	displayName: string;
	sourceType: McpConnectionSourceType;
	pieceName: string | null;
	serverKey: string | null;
	connectionExternalId: string | null;
	serverUrl: string | null;
	status: string;
	metadata: Record<string, unknown> | null;
};

export type McpCatalogEntry = {
	pieceName: string;
	canonicalPieceName: string;
	displayName: string;
	description: string | null;
	logoUrl: string | null;
	categories: string[];
	authType: string;
	authDisplayName: string | null;
	requiresAuth: boolean;
	isOAuth2: boolean;
	oauthAppConfigured: boolean;
	actionCount: number;
	registryRef: string;
	serverUrl: string;
	appConnections: Omit<McpCatalogAppConnectionSummary, "pieceName">[];
	mcpConnection: McpCatalogConfiguredConnectionSummary | null;
	availableOnly: boolean;
};

export type McpConnectionCatalogReadModel = {
	entries: McpCatalogEntry[];
};

export type McpAvailabilityReadModel = {
	entries: McpServerAvailabilityEntry[];
	projectConnections: McpCatalogConfiguredConnectionSummary[];
	customConnections: McpCatalogConfiguredConnectionSummary[];
	source: {
		catalogPath: string | null;
		registeredCount: number;
	};
};

export type ProjectMembershipRole = "ADMIN" | "EDITOR" | "OPERATOR" | "VIEWER";

export type WorkspaceSummary = {
	id: string;
	displayName: string;
	externalId: string;
	slug: string;
	role: ProjectMembershipRole;
	isCurrent: boolean;
	createdAt: string;
};

export type WorkspaceProjectMembershipRecord = {
	id: string;
	displayName: string;
	externalId: string;
	role: ProjectMembershipRole;
	createdAt: Date;
};

export type CreateWorkspaceProjectInput = {
	platformId: string;
	ownerId: string;
	displayName: string;
	externalId: string;
};

export type EncryptedSecretValue = {
	iv: string;
	data: string;
};

export type HostedMcpServerStatus = "ENABLED" | "DISABLED";

export type HostedMcpInputProperty = {
	name: string;
	type: string;
	description?: string;
	required?: boolean;
};

export type HostedMcpWorkflow = {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	trigger: {
		toolName: string;
		toolDescription: string;
		inputSchema: HostedMcpInputProperty[];
		returnsResponse: boolean;
	};
};

export type HostedMcpServerRecord = {
	id: string;
	projectId: string;
	status: HostedMcpServerStatus;
	tokenEncrypted: EncryptedSecretValue;
	createdAt: Date;
	updatedAt: Date;
};

export type HostedMcpWorkflowSourceRecord = {
	id: string;
	name: string;
	description: string | null;
	nodes: unknown;
};

export type HostedMcpServerReadModel = Omit<
	HostedMcpServerRecord,
	"tokenEncrypted"
> & {
	token: string;
	flows: HostedMcpWorkflow[];
};

export type ProjectMcpCatalogServerEntry = {
	name: string;
	displayName: string;
	url: string;
	sourceType: McpConnectionSourceType;
	pieceName?: string | null;
	serverKey?: string | null;
	connectionExternalId?: string | null;
	headers?: Record<string, string>;
	toolAllowlist?: string[];
};

export type InternalProjectMcpCatalogReadModel = {
	projectId: string;
	projectExternalId: string;
	servers: ProjectMcpCatalogServerEntry[];
};

export type HostedMcpServerResult =
	| {
			ok: true;
			status: 200;
			server: HostedMcpServerReadModel;
	  }
	| {
			ok: false;
			status: 400 | 403;
			message: string;
	  };

export type InternalHostedMcpServerResult =
	| {
			ok: true;
			status: 200;
			server: HostedMcpServerReadModel;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type InternalProjectMcpCatalogResult =
	| {
			ok: true;
			status: 200;
			catalog: InternalProjectMcpCatalogReadModel;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type StartHostedMcpWorkflowToolInput = {
	projectId: string;
	workflowId: string;
	toolName?: unknown;
	input?: unknown;
	traceHeaders?: Record<string, string>;
};

export type StartHostedMcpWorkflowToolResult =
	| {
			ok: true;
			status: 200;
			runId: string;
			executionId: string;
			instanceId: string;
			returnsResponse: boolean;
	  }
	| {
			ok: false;
			status: 400 | 403 | 404 | 502 | 503;
			message: string;
	  };

export type McpRunStatus = "STARTED" | "RESPONDED" | "TIMED_OUT" | "FAILED";

export type McpRunRecord = {
	id: string;
	projectId: string;
	mcpServerId: string;
	workflowId: string;
	workflowExecutionId: string | null;
	daprInstanceId: string | null;
	toolName: string;
	input: Record<string, unknown>;
	response: unknown;
	status: McpRunStatus;
	respondedAt: Date | null;
	createdAt: Date;
	updatedAt: Date;
};

export type AppConnectionRecord = {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	scope: string;
	ownerId: string | null;
	platformId: string | null;
	projectIds: string[];
	createdAt: Date;
	updatedAt: Date;
};

export type AppConnectionPieceInfoRecord = {
	name: string;
	displayName: string;
	logoUrl: string | null;
	categories: string[];
};

export type AppConnectionListItem = Omit<AppConnectionRecord, "projectIds"> & {
	providerId: string;
	providerLabel: string;
	providerIconUrl: string | null;
	category: string | null;
};

export type AppConnectionCreatedRecord = Pick<
	AppConnectionRecord,
	| "id"
	| "externalId"
	| "pieceName"
	| "displayName"
	| "type"
	| "status"
	| "scope"
	| "createdAt"
	| "updatedAt"
>;

export type AppConnectionUpdatedRecord = Pick<
	AppConnectionRecord,
	"id" | "externalId" | "pieceName" | "displayName" | "type" | "status" | "createdAt"
>;

export type AppConnectionSummaryRecord = Pick<
	AppConnectionRecord,
	"id" | "externalId" | "pieceName" | "displayName" | "type" | "status" | "createdAt"
>;

export type AppConnectionSecretRecord = AppConnectionRecord & {
	value: unknown;
	pieceVersion: string | null;
};

export type AppConnectionOAuthPieceMetadataRecord = {
	name: string;
	version: string;
	auth: unknown;
};

export type AppConnectionPlatformOAuthAppRecord = {
	pieceName: string;
	platformId: string | null;
	clientId: string;
	clientSecret: unknown;
};

export type AppConnectionOAuthCompletedRecord = Pick<
	AppConnectionRecord,
	| "id"
	| "externalId"
	| "pieceName"
	| "displayName"
	| "type"
	| "status"
	| "createdAt"
	| "updatedAt"
>;

export type AppConnectionSummary = AppConnectionSummaryRecord & {
	pieceDisplayName: string | null;
	pieceLogoUrl: string | null;
};

export type DecryptedAppConnection = Pick<
	AppConnectionRecord,
	"id" | "externalId" | "pieceName" | "displayName" | "type" | "status"
> & {
	value: Record<string, unknown>;
};

export type AppConnectionCreateInput = {
	projectId: string;
	userId?: string | null;
	platformId?: string | null;
	pieceName?: unknown;
	displayName?: unknown;
	type?: unknown;
	value?: unknown;
	scope?: unknown;
};

export type AppConnectionCreateResult =
	| {
			ok: true;
			connection: AppConnectionCreatedRecord;
	  }
	| {
			ok: false;
			status: 400 | 503;
			message: string;
	  };

export type AppConnectionUpdateResult =
	| {
			ok: true;
			connection: AppConnectionUpdatedRecord;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type AppConnectionDeleteResult =
	| { ok: true }
	| {
			ok: false;
			status: 404;
			message: string;
	  };

export type AppConnectionOAuth2StartResult =
	| {
			ok: true;
			authorizationUrl: string;
			clientId: string;
			state: string;
			codeVerifier: string;
			codeChallenge: string;
			redirectUrl: string;
			scope: string;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type AppConnectionOAuth2CompleteResult =
	| {
			ok: true;
			connection: AppConnectionOAuthCompletedRecord | null;
	  }
	| {
			ok: false;
			status: 400 | 404;
			message: string;
	  };

export type DecryptedAppConnectionResult =
	| {
			ok: true;
			connection: DecryptedAppConnection;
	  }
	| {
			ok: false;
			status: 404;
			message: string;
	  };

export type CreateMcpConnectionRecordInput = {
	id: string;
	projectId: string;
	sourceType: McpConnectionSourceType;
	pieceName: string | null;
	serverKey: string | null;
	connectionExternalId: string | null;
	displayName: string;
	registryRef: string | null;
	serverUrl: string | null;
	status: McpConnectionStatus;
	metadata: Record<string, unknown> | null;
	createdBy: string | null;
	updatedBy: string | null;
	lastSyncAt?: Date | null;
	lastError?: string | null;
};

export type CreateProjectMcpConnectionInput = {
	projectId: string;
	userId: string;
	sourceType?: unknown;
	pieceName?: unknown;
	displayName?: unknown;
	serverUrl?: unknown;
	connectionExternalId?: unknown;
	metadata?: unknown;
};

export type UpdateProjectMcpConnectionInput = {
	id: string;
	projectId: string;
	userId: string;
	status?: unknown;
	connectionExternalId?: unknown;
	connectionExternalIdProvided?: boolean;
	toolSelection?: unknown;
	toolSelectionProvided?: boolean;
};

export interface McpConnectionRepository {
	listProjectConnections(projectId: string): Promise<McpConnectionRecord[]>;
	findProjectConnection(input: {
		id: string;
		projectId: string;
	}): Promise<McpConnectionRecord | null>;
	findProjectNimblePieceConnection(input: {
		projectId: string;
		pieceName: string;
	}): Promise<McpConnectionRecord | null>;
	createProjectConnection(input: CreateMcpConnectionRecordInput): Promise<McpConnectionRecord>;
	updateProjectConnection(input: {
		id: string;
		projectId: string;
		status?: McpConnectionStatus;
		connectionExternalId?: string | null;
		displayName?: string;
		registryRef?: string | null;
		serverUrl?: string | null;
		metadata?: Record<string, unknown> | null;
		updatedBy: string;
	}): Promise<McpConnectionRecord | null>;
	deleteProjectConnection(input: { id: string; projectId: string }): Promise<void>;
	activeAppConnectionExistsForPiece(input: {
		projectId: string;
		externalId: string;
		pieceNameCandidates: string[];
	}): Promise<boolean>;
	listActiveAppConnectionCatalogSummaries(
		projectId: string,
	): Promise<McpCatalogAppConnectionSummary[]>;
	listPlatformOAuthAppPieceNames(input: {
		pieceNames: string[];
		platformId?: string | null;
	}): Promise<string[]>;
}

export interface HostedMcpServerRepository {
	resolveProjectByIdOrExternalId(
		projectRef: string,
	): Promise<{ id: string; externalId: string } | null>;
	getServerByProjectId(projectId: string): Promise<HostedMcpServerRecord | null>;
	createServer(input: {
		id: string;
		projectId: string;
		status: HostedMcpServerStatus;
		tokenEncrypted: EncryptedSecretValue;
	}): Promise<HostedMcpServerRecord>;
	updateServerStatus(input: {
		id: string;
		status: HostedMcpServerStatus;
	}): Promise<void>;
	updateServerToken(input: {
		id: string;
		tokenEncrypted: EncryptedSecretValue;
	}): Promise<void>;
	getProjectOwnerId(projectId: string): Promise<string | null>;
	listWorkflowSourcesForProject(input: {
		projectId: string;
		ownerId: string;
	}): Promise<HostedMcpWorkflowSourceRecord[]>;
	upsertHostedWorkflowConnection(input: {
		projectId: string;
		displayName?: string | null;
		serverUrl?: string | null;
		registryRef?: string | null;
		status: McpConnectionStatus;
		metadata?: Record<string, unknown> | null;
		lastError?: string | null;
		actorUserId?: string | null;
	}): Promise<McpConnectionRecord>;
}

export interface McpRunRepository {
	createRun(input: {
		projectId: string;
		mcpServerId: string;
		workflowId: string;
		toolName: string;
		input: Record<string, unknown>;
	}): Promise<McpRunRecord>;
	attachExecution(input: {
		runId: string;
		workflowExecutionId: string;
		daprInstanceId: string | null;
	}): Promise<void>;
	getRun(runId: string): Promise<McpRunRecord | null>;
	respondToRun(input: {
		runId: string;
		response: unknown;
	}): Promise<McpRunRecord | null>;
}

export interface AppConnectionRepository {
	listProjectConnections(projectId: string): Promise<AppConnectionRecord[]>;
	listConnectionSummaries(input: {
		pieceNameCandidates?: string[];
	}): Promise<AppConnectionSummaryRecord[]>;
	listPieceInfo(): Promise<AppConnectionPieceInfoRecord[]>;
	findConnectionById(id: string): Promise<AppConnectionSecretRecord | null>;
	findConnectionByExternalId(externalId: string): Promise<AppConnectionSecretRecord | null>;
	findOAuthPieceMetadata(input: {
		pieceNameCandidates: string[];
		pieceVersion?: string | null;
	}): Promise<AppConnectionOAuthPieceMetadataRecord | null>;
	findPlatformOAuthApp(input: {
		pieceNameCandidates: string[];
		platformId?: string | null;
	}): Promise<AppConnectionPlatformOAuthAppRecord | null>;
	createConnection(input: {
		id: string;
		externalId: string;
		pieceName: string;
		displayName: string;
		type: string;
		status: string;
		scope: string;
		value: { iv: string; data: string };
		pieceVersion: string;
		projectIds: string[];
		ownerId: string | null;
		platformId: string | null;
	}): Promise<AppConnectionCreatedRecord>;
	updateDisplayName(input: {
		id: string;
		projectId: string;
		displayName: string;
	}): Promise<AppConnectionUpdatedRecord | null>;
	updateOAuthConnection(input: {
		id: string;
		value: { iv: string; data: string };
		pieceName: string;
		pieceVersion: string;
		projectIds: string[];
	}): Promise<AppConnectionOAuthCompletedRecord | null>;
	updateEncryptedValue(input: {
		id: string;
		value: { iv: string; data: string };
	}): Promise<void>;
	deleteProjectConnection(input: { id: string; projectId: string }): Promise<boolean>;
}

export interface AdminPieceRepository {
	listCatalogPieces(input: {
		availableOnly: boolean;
	}): Promise<AdminPieceMetadataRecord[]>;
	listDisabledPieceNames(): Promise<string[]>;
	listWorkflowReferencedPieceNames(): Promise<string[]>;
	listEnabledMcpPieceNames(): Promise<string[]>;
	listLatestImageStatuses(
		pieceNames: string[],
	): Promise<AdminPieceImageStatusRecord[]>;
	setPieceEnabled(input: {
		pieceName: string;
		enabled: boolean;
		disabledBy?: string | null;
		platformId?: string;
	}): Promise<void>;
}

export interface WorkspaceProjectRepository {
	getMemberProjectId(input: {
		projectId: string;
		userId: string;
	}): Promise<string | null>;
	getFallbackMemberProjectId(userId: string): Promise<string | null>;
	listWorkspaceMemberships(input: {
		userId: string;
	}): Promise<WorkspaceProjectMembershipRecord[]>;
	createWorkspaceProject(
		input: CreateWorkspaceProjectInput,
	): Promise<WorkspaceProjectMembershipRecord>;
	updateWorkspaceDisplayName(input: {
		projectId: string;
		displayName: string;
	}): Promise<boolean>;
	getMemberProjectIdBySlug(input: {
		slug: string;
		userId: string;
	}): Promise<string | null>;
	getProjectExternalId(projectId: string): Promise<string | null>;
	getProjectMembershipDetail(input: {
		projectId: string;
		userId: string;
	}): Promise<WorkspaceProjectMembershipDetail | null>;
	getProjectMemberRole(input: {
		projectId: string;
		userId: string;
	}): Promise<ProjectMembershipRole | null>;
	listProjectMembers(projectId: string): Promise<ProjectMemberListItem[]>;
	findPlatformUserForProject(input: {
	projectId: string;
	userId?: string | null;
	email?: string | null;
	}): Promise<
		| { ok: true; userId: string }
		| { ok: false; reason: "project_not_found" | "user_not_found" | "different_platform" }
	>;
	getProjectMember(input: {
		projectId: string;
		memberId: string;
	}): Promise<ProjectMemberRecord | null>;
	projectMemberExists(input: {
		projectId: string;
		userId: string;
	}): Promise<boolean>;
	countProjectAdmins(projectId: string): Promise<number>;
	addProjectMember(input: {
		projectId: string;
		userId: string;
		role: ProjectMembershipRole;
	}): Promise<ProjectMemberRecord>;
	updateProjectMemberRole(input: {
		projectId: string;
		memberId: string;
		role: ProjectMembershipRole;
	}): Promise<ProjectMemberRecord | null>;
	deleteProjectMember(input: {
		projectId: string;
		memberId: string;
	}): Promise<void>;
}

export interface PieceCatalogRepository {
	getLatestPieceMetadata(
		pieceNameCandidates: string[],
	): Promise<PieceMetadataDetailRecord | null>;
	listConnectablePieces(input: {
		authOnly: boolean;
	}): Promise<ConnectablePieceRecord[]>;
	listPieceCatalogFunctions(): Promise<CatalogFunctionSummary[]>;
	listMcpCatalogPieces(): Promise<McpCatalogPieceRecord[]>;
	listConnectionUsageByPieceNames(input: {
		pieceNameCandidates: string[];
		projectId: string;
	}): Promise<PieceConnectionUsageRecord[]>;
}

export interface CodeFunctionCatalogRepository {
	listEnabledForCatalog(userId: string): Promise<CodeCatalogFunctionRecord[]>;
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

export interface WorkflowDefinitionRepository {
	getById(id: string): Promise<WorkflowDefinition | null>;
	getLatestByName(name: string): Promise<WorkflowDefinition | null>;
	getByRef(ref: WorkflowRef): Promise<WorkflowDefinition | null>;
	list(input: {
		limit: number;
		projectId?: string | null;
	}): Promise<WorkflowDefinitionListItem[]>;
	listForWorkspace(input: {
		limit: number;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkspaceWorkflowDefinitionSummary[]>;
	findProjectWorkflowIdByIdOrNamePrefix(input: {
		projectId: string;
		workflowId: string;
		namePrefix: string;
	}): Promise<string | null>;
	create(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition>;
	update(id: string, input: UpdateWorkflowDefinitionInput): Promise<WorkflowDefinition | null>;
	hasActiveExecutions(id: string): Promise<boolean>;
	delete(id: string): Promise<void>;
}

export interface ModelCatalogRepository {
	listEnabledModelIds(): Promise<string[]>;
}

export type WorkflowExecutionStatus = "pending" | "running" | "success" | "error" | "cancelled";

export type WorkflowExecutionRecentRunRecord = {
	workflowId: string;
	id: string;
	status: string;
	startedAt: Date;
	completedAt: Date | null;
};

export type WorkflowExecutionForkCountRecord = {
	workflowId: string;
	count: number;
};

export type WorkflowExecutionPickerRecord = {
	id: string;
	status: string;
	startedAt: Date;
	workflowId: string | null;
};

export type CreateWorkflowExecutionInput = {
	id?: string;
	workflowId: string;
	userId: string;
	projectId?: string | null;
	status: WorkflowExecutionStatus;
	phase?: string | null;
	progress?: number | null;
	input?: Record<string, unknown>;
	output?: unknown;
	executionIr?: unknown;
	executionIrVersion?: string | null;
	triggerSource?: string;
	rerunOfExecutionId?: string;
	rerunSourceInstanceId?: string;
	resumeFromNode?: string;
	workflowSessionId?: string | null;
};

export type WorkflowExecutionRecord = {
	id: string;
	workflowId: string;
	userId: string;
	projectId: string | null;
	status: WorkflowExecutionStatus;
	input: Record<string, unknown> | null;
	output: unknown;
	executionIrVersion: string | null;
	executionIr: unknown;
	error: string | null;
	daprInstanceId: string | null;
	phase: string | null;
	progress: number | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	primaryTraceId: string | null;
	workflowSessionId: string | null;
	/** Legacy storage fields retained for old rows only. */
	mlflowExperimentId: string | null;
	mlflowRunId: string | null;
	summaryOutput: Record<string, unknown> | null;
	errorStackTrace: string | null;
	rerunOfExecutionId: string | null;
	rerunSourceInstanceId: string | null;
	resumeFromNode: string | null;
	triggerSource: string | null;
	rerunFromEventId: number | null;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
	stopRequestedAt: Date | null;
	stopReason: string | null;
};

export type WorkflowExecutionScopeInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionLineageNode = {
	id: string;
	status: string | null;
	fromNodeId: string | null;
	parentId: string | null;
	startedAt: string | null;
	completedAt: string | null;
	durationMs: number | null;
	isCurrent: boolean;
};

export type WorkflowExecutionLineage = {
	rootId: string;
	currentId: string;
	nodes: WorkflowExecutionLineageNode[];
};

export type WorkflowExecutionListItem = {
	id: string;
	workflowId: string;
	status: WorkflowExecutionStatus;
	daprInstanceId: string | null;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
	input?: Record<string, unknown> | null;
	output?: unknown;
};

export type WorkflowExecutionRunSummary = {
	id: string;
	workflowId: string;
	status: WorkflowExecutionStatus;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
	sessionIds: string[];
	agents: Array<{ id: string; name: string }>;
};

export type WorkflowExecutionSessionSummary = {
	id: string;
	title: string | null;
	status: string | null;
	agentId: string | null;
	workflowExecutionId: string | null;
	createdAt: Date;
	completedAt: Date | null;
};

export type WorkflowExecutionOutputFile = {
	id: string;
	name: string;
	contentType: string | null;
	sizeBytes: number;
	createdAt: Date;
};

export type WorkflowExecutionOutputFiles = {
	files: WorkflowExecutionOutputFile[];
	liveSandbox: { name: string } | null;
	cliWorkspace: boolean;
};

export type WorkflowExecutionWorkspaceEntry = {
	path: string;
	isDir: boolean;
	sizeBytes: number;
};

export type WorkflowExecutionWorkspaceTree = {
	entries: WorkflowExecutionWorkspaceEntry[];
	truncated: boolean;
	error?: string;
};

export type WorkflowExecutionWorkspaceFile = {
	bytes: ArrayBuffer | Buffer;
	contentType: string;
};

export interface WorkflowExecutionWorkspacePort {
	listTree(instanceId: string): Promise<WorkflowExecutionWorkspaceTree>;
	readFile(
		instanceId: string,
		relPath: string,
	): Promise<WorkflowExecutionWorkspaceFile | null>;
}

export type WorkflowExecutionUsageMetricsRow = {
	modelSpec: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreateTokens: number;
};

export type WorkflowExecutionSessionOwnerContext = {
	userId: string;
	workflowId: string;
	projectId: string | null;
};

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

export type UsageReportingScope = {
	userId: string;
	projectId?: string | null;
};

export type UsageAnalyticsTotalsRecord = {
	tokensIn: number;
	tokensOut: number;
	cacheReadTokens: number;
	cacheCreateTokens: number;
	sessionCount: number;
	toolCalls: number;
};

export type UsageAnalyticsDailyRecord = {
	day: string;
	tokensIn: number;
	tokensOut: number;
};

export type UsageAnalyticsAgentRecord = {
	agentId: string;
	agentName: string | null;
	tokensIn: number;
	tokensOut: number;
	sessions: number;
};

export type UsageAnalyticsSnapshot = {
	totals: UsageAnalyticsTotalsRecord;
	daily: UsageAnalyticsDailyRecord[];
	byAgent: UsageAnalyticsAgentRecord[];
};

export type UsageCostRow = {
	agentId: string;
	agentName: string | null;
	modelSpec: string | null;
	sessions: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreateTokens: number;
};

export type LiveLimitModelRecord = {
	model: string;
	sessionsLastHour: number;
	tokensInLastHour: number;
	tokensOutLastHour: number;
	tokensInLastMinute: number;
	tokensOutLastMinute: number;
};

export type LiveLimitSnapshot = {
	activeSessions: number;
	byModel: LiveLimitModelRecord[];
};

export type UsageAnalyticsReadModel = UsageAnalyticsSnapshot & {
	range: { start: string; end: string };
	groupBy: string;
};

export type CostBreakdownReadModel = {
	range: { start: string; end: string };
	totalCost: number;
	priceBook: Array<{
		model: string;
		inputPerMillion: number;
		outputPerMillion: number;
	}>;
	byAgent: Array<{
		agentId: string;
		agentName: string;
		sessions: number;
		cost: number;
	}>;
	byModel: Array<{
		model: string;
		sessions: number;
		inputTokens: number;
		outputTokens: number;
		cost: number;
	}>;
};

export type LiveLimitReadModel = LiveLimitSnapshot & {
	asOf: string;
};

export type SandboxExecutionRecord = {
	executionId: string;
	workflowId: string | null;
	workflowName: string | null;
	status: string;
	startedAt: Date | null;
	completedAt: Date | null;
};

export type SandboxExecutionReadModel = {
	executionId: string;
	workflowId: string | null;
	workflowName: string;
	status: string;
	startedAt: string | null;
	completedAt: string | null;
};

export type SandboxRuntimeRecord = {
	name: string;
	phase: string;
	createdAt?: string | null;
};

export type SandboxStatsReadModel = {
	total: number;
	byPhase: Record<string, number>;
	executions24h: number;
	avgAgeMinutes: number;
};

export type ActiveWorkflowExecutionReadModel = {
	id: string;
	workflowId: string;
	workflowName: string | null;
	status: WorkflowExecutionStatus;
	phase: string | null;
	approvalEventName: null;
};

export type InternalAgentWorkflowExecutionListItem = {
	id: string;
	workflowId: string;
	status: WorkflowExecutionStatus;
	phase: string | null;
	progress: number | null;
	error: string | null;
	startedAt: Date;
	completedAt: Date | null;
	workflow: {
		id: string;
		name: string;
		description: string | null;
	};
};

export type InternalAgentWorkflowExecutionListReadModel = {
	success: true;
	executions: InternalAgentWorkflowExecutionListItem[];
	total: number;
};

export type InternalAgentWorkflowExecutionListInput = {
	workflowId?: string | null;
	workflowName?: string | null;
	status?: WorkflowExecutionStatus | null;
	limit: number;
	offset: number;
};

export interface SandboxInventoryRepository {
	listRecentExecutionsForSandbox(sandboxName: string): Promise<SandboxExecutionRecord[]>;
	countExecutionsSince(cutoff: Date): Promise<number>;
}

export interface SandboxRuntimeInventory {
	listSandboxes(): Promise<SandboxRuntimeRecord[]>;
}

export interface UsageReportingRepository {
	getUsageAnalytics(input: {
		scope: UsageReportingScope;
		start: Date;
		end: Date;
	}): Promise<UsageAnalyticsSnapshot>;
	listCostUsageRows(input: {
		scope: UsageReportingScope;
		start: Date;
		end: Date;
	}): Promise<UsageCostRow[]>;
	getLiveLimitSnapshot(input: {
		scope: UsageReportingScope;
		now: Date;
	}): Promise<LiveLimitSnapshot>;
}

export type WorkflowExecutionReadModelPatch = Partial<
	Pick<
		WorkflowExecutionRecord,
		| "status"
		| "phase"
		| "progress"
		| "output"
		| "error"
		| "summaryOutput"
		| "currentNodeId"
		| "currentNodeName"
		| "primaryTraceId"
		| "workflowSessionId"
		| "completedAt"
		| "duration"
	>
>;

export type WorkflowExecutionLogStatus = "pending" | "running" | "success" | "error";

export type AppendWorkflowExecutionLogInput = {
	id?: string;
	executionId: string;
	nodeId: string;
	nodeName: string;
	nodeType: string;
	activityName?: string | null;
	status: WorkflowExecutionLogStatus;
	input?: unknown;
	output?: unknown;
	error?: string | null;
	startedAt?: Date;
	completedAt?: Date | null;
	duration?: string | null;
	credentialFetchMs?: number | null;
	routingMs?: number | null;
	coldStartMs?: number | null;
	executionMs?: number | null;
	routedTo?: string | null;
	wasColdStart?: boolean | null;
};

export type WorkflowExecutionLogRecord = {
	id: string;
	executionId: string;
	nodeId: string;
	nodeName: string;
	nodeType: string;
	activityName: string | null;
	status: WorkflowExecutionLogStatus;
	input: unknown;
	output: unknown;
	error: string | null;
	startedAt: Date;
	completedAt: Date | null;
	duration: string | null;
	timestamp: Date;
	credentialFetchMs: number | null;
	routingMs: number | null;
	coldStartMs: number | null;
	executionMs: number | null;
	routedTo: string | null;
	wasColdStart: boolean | null;
};

export type WorkflowExecutionAgentEventRecord = {
	id: number;
	sessionId: string;
	type: string;
	sourceEventId: string | null;
	data: Record<string, unknown>;
	createdAt: Date;
};

export type WorkflowExecutionLogPatch = Partial<
	Pick<
		WorkflowExecutionLogRecord,
		| "status"
		| "output"
		| "error"
		| "completedAt"
		| "duration"
		| "credentialFetchMs"
		| "routingMs"
		| "coldStartMs"
		| "executionMs"
		| "routedTo"
		| "wasColdStart"
	>
>;

export interface WorkflowExecutionRepository {
	assertReadModelReady(): Promise<void>;
	getById(id: string): Promise<WorkflowExecutionRecord | null>;
	getByDaprInstanceId(instanceId: string): Promise<WorkflowExecutionRecord | null>;
	getSessionOwnerContext(
		executionId: string,
	): Promise<WorkflowExecutionSessionOwnerContext | null>;
	getExecutionWorkspaceRoute(
		executionId: string,
	): Promise<ExecutionWorkspaceRouteInfo | null>;
	getRunningByWorkflowId(workflowId: string): Promise<{ id: string; status: string } | null>;
	getLineage(executionId: string): Promise<WorkflowExecutionLineage | null>;
	listActiveForUser(userId: string): Promise<ActiveWorkflowExecutionReadModel[]>;
	listForInternalAgent(
		input: InternalAgentWorkflowExecutionListInput,
	): Promise<InternalAgentWorkflowExecutionListReadModel>;
	listByWorkflowId(input: {
		workflowId: string;
		limit: number;
		include?: "summary" | "full";
	}): Promise<WorkflowExecutionListItem[]>;
	listRunSummariesByWorkflowId(input: {
		workflowId: string;
		limit: number;
	}): Promise<WorkflowExecutionRunSummary[]>;
	countForksByWorkflowIds(
		workflowIds: string[],
	): Promise<WorkflowExecutionForkCountRecord[]>;
	listRecentRunsByWorkflowIds(input: {
		workflowIds: string[];
		limitPerWorkflow: number;
	}): Promise<WorkflowExecutionRecentRunRecord[]>;
	listRecentExecutionPickerRecords(input: {
		userId: string;
		projectId?: string | null;
		limit: number;
	}): Promise<WorkflowExecutionPickerRecord[]>;
	listSessionsForExecutionLineage(input: {
		executionId: string;
		projectId?: string | null;
		maxAncestors?: number;
	}): Promise<WorkflowExecutionSessionSummary[]>;
	listOutputFilesByExecutionId(
		executionId: string,
	): Promise<WorkflowExecutionOutputFiles>;
	aggregateUsageMetricsForExecutionLineage(input: {
		executionId: string;
		projectId?: string | null;
		maxAncestors?: number;
	}): Promise<WorkflowExecutionUsageMetricsRow[]>;
	create(input: CreateWorkflowExecutionInput): Promise<{ id: string }>;
	attachSchedulerInstance(input: {
		executionId: string;
		instanceId: string;
		workflowSessionId?: string | null;
		primaryTraceId?: string | null;
	}): Promise<void>;
	markStartFailed(input: { executionId: string; error: string }): Promise<void>;
	listStaleRunningExecutions(input: {
		olderThanMinutes: number;
	}): Promise<Pick<WorkflowExecutionRecord, "id" | "daprInstanceId" | "input">[]>;
	updateReadModel(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	): Promise<void>;
	appendLog(input: AppendWorkflowExecutionLogInput): Promise<WorkflowExecutionLogRecord>;
	updateLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	): Promise<WorkflowExecutionLogRecord | null>;
	listLogsByExecutionId(executionId: string): Promise<WorkflowExecutionLogRecord[]>;
	listSessionIdsByExecutionId(executionId: string): Promise<string[]>;
	countActiveTriggeredRuns(input: { statuses: WorkflowExecutionStatus[] }): Promise<number>;
	listAgentEventsByExecutionId(
		executionId: string,
	): Promise<WorkflowExecutionAgentEventRecord[]>;
	listAgentEventsByExecutionIdAfter(input: {
		executionId: string;
		afterEventId: number;
	}): Promise<WorkflowExecutionAgentEventRecord[]>;
}

export type WorkflowArtifactInput = {
	id: string;
	workflowExecutionId: string;
	nodeId?: string | null;
	slot?: "primary" | "secondary" | "aux" | null;
	kind: string;
	title: string;
	description?: string | null;
	inlinePayload?: unknown;
	fileId?: string | null;
	contentType?: string | null;
	sizeBytes?: number | null;
	metadata?: Record<string, unknown> | null;
};

export type WorkflowArtifactRecord = {
	id: string;
	workflowExecutionId: string;
	nodeId: string | null;
	slot: "primary" | "secondary" | "aux" | null;
	kind: string;
	title: string;
	description: string | null;
	inlinePayload: unknown;
	fileId: string | null;
	contentType: string | null;
	sizeBytes: number | null;
	metadata: Record<string, unknown> | null;
	createdAt: Date;
};

export type WorkflowFileRecord = {
	id: string;
	name: string;
	purpose: "agent" | "output";
	scopeId: string | null;
	contentType: string | null;
	sizeBytes: number;
	sha1: string | null;
	createdAt: string;
	archivedAt: string | null;
};

export type CreateWorkflowFileInput = {
	userId: string;
	projectId?: string | null;
	name: string;
	purpose: "agent" | "output";
	scopeId?: string | null;
	contentType?: string | null;
	bytes: Buffer;
};

export type ListWorkflowFilesFilter = {
	userId: string;
	purpose?: "agent" | "output";
	scopeId?: string;
	limit?: number;
	includeArchived?: boolean;
};

export type WorkflowRunDiffStats = {
	files: number;
	additions: number;
	deletions: number;
};

export type PersistWorkflowRunDiffInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	nodeId?: string | null;
	title?: string;
	patch: string;
	baseRef?: string | null;
	headRef?: string | null;
	stats?: Partial<WorkflowRunDiffStats> | null;
};

export type PersistWorkflowSourceBundleInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	nodeId?: string | null;
	iteration?: number | null;
	fileName?: string;
	bytes: Buffer;
	contentType?: string;
	meta?: {
		base?: string | null;
		head?: string | null;
		tier?: string | null;
		clonePath?: string | null;
		fileCount?: number | null;
		repoUrl?: string | null;
		repoSubdir?: string | null;
		syncPaths?: string[] | null;
		iteration?: number | null;
	};
};

export interface WorkflowFileStore {
	createFile(input: CreateWorkflowFileInput): Promise<{
		file: WorkflowFileRecord;
		deduplicated: boolean;
	}>;
	listFiles(filter: ListWorkflowFilesFilter): Promise<WorkflowFileRecord[]>;
	getFile(id: string): Promise<WorkflowFileRecord | null>;
	getFileContent(id: string): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
	archiveFile(input: { id: string; userId: string }): Promise<boolean>;
	deleteFile(input: { id: string; userId: string }): Promise<boolean>;
}

export type WorkflowMcpResolutionResult = AgentMcpResolutionResult & {
	projectId: string | null;
};

export interface ArtifactStore {
	upsertWorkflowArtifact(input: WorkflowArtifactInput): Promise<{ id: string }>;
	listWorkflowArtifactsByExecutionId(executionId: string): Promise<WorkflowArtifactRecord[]>;
	listSourceBundleArtifactsByWorkflowId(workflowId: string): Promise<WorkflowArtifactRecord[]>;
	getWorkflowArtifactForExecution(input: {
		executionId: string;
		artifactId: string;
	}): Promise<WorkflowArtifactRecord | null>;
	updateWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		metadata: Record<string, unknown> | null;
	}): Promise<WorkflowArtifactRecord | null>;
}

export type SourceBundlePromotionMode = "pr" | "branch";

export type SourceBundlePromotionGateInput = {
	mode: SourceBundlePromotionMode;
	artifactPayload: Record<string, unknown>;
	executionOutput: unknown;
	summaryOutput: Record<string, unknown> | null;
};

export type SourceBundlePromotionGateResult = {
	allowed: boolean;
	[key: string]: unknown;
};

export interface SourceBundlePromotionGatePort {
	evaluatePromotionGate(
		input: SourceBundlePromotionGateInput,
	): SourceBundlePromotionGateResult;
}

export type SourceBundlePromotionRunnerInput = {
	executionId: string;
	fileId: string;
	repo: string;
	base: string;
	mode: SourceBundlePromotionMode;
	title: string;
	tier: string;
	repoSubdir: string;
	syncPaths: string[];
};

export type SourceBundlePromotionRunnerResult =
	| {
			status: "ok";
			output: string;
			prUrl: string | null;
			branch: string | null;
			prError: string | null;
	  }
	| { status: "command_error"; error: string; output: string }
	| { status: "unavailable"; message: string };

export interface SourceBundlePromotionRunnerPort {
	promoteSourceBundle(
		input: SourceBundlePromotionRunnerInput,
	): Promise<SourceBundlePromotionRunnerResult>;
}

export type WorkspaceSessionBackend = "openshell" | "juicefs";
export type WorkspaceSessionStatus = "active" | "cleaned" | "error";

export type UpsertWorkspaceSessionInput = {
	workspaceRef: string;
	workflowExecutionId?: string | null;
	durableInstanceId?: string | null;
	name: string;
	rootPath: string;
	clonePath?: string | null;
	backend: WorkspaceSessionBackend;
	enabledTools?: string[];
	status?: WorkspaceSessionStatus;
	sandboxState?: Record<string, unknown> | null;
};

export type WorkflowWorkspaceSessionRecord = {
	workspaceRef: string;
	workflowExecutionId: string | null;
	status: WorkspaceSessionStatus;
	sandboxState: Record<string, unknown> | null;
	createdAt: Date;
};

export interface WorkspaceSessionStore {
	upsertWorkflowWorkspaceSession(
		input: UpsertWorkspaceSessionInput,
	): Promise<{ workspaceRef: string }>;
	listWorkflowWorkspaceSessionsByExecutionId(input: {
		executionId: string;
		limit?: number;
	}): Promise<WorkflowWorkspaceSessionRecord[]>;
	markWorkflowWorkspaceSessionCleaned(input: {
		workspaceRef: string;
	}): Promise<boolean>;
}

export type WorkflowAgentRunMode = "run" | "plan" | "execute_plan";
export type WorkflowAgentRunStatus =
	| "scheduled"
	| "running"
	| "completed"
	| "failed"
	| "event_published";

export type UpsertWorkflowAgentRunScheduledInput = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	mode: WorkflowAgentRunMode;
	agentWorkflowId: string;
	daprInstanceId: string;
	parentExecutionId: string;
	workspaceRef?: string | null;
	artifactRef?: string | null;
};

export type UpdateWorkflowAgentRunLifecycleInput = {
	id: string;
	status: Extract<WorkflowAgentRunStatus, "running" | "completed" | "failed">;
	result?: Record<string, unknown> | null;
	error?: string | null;
	workspaceRef?: string | null;
	eventPublished?: boolean;
};

export interface WorkflowAgentRunStore {
	upsertScheduledAgentRun(
		input: UpsertWorkflowAgentRunScheduledInput,
	): Promise<{ id: string }>;
	updateAgentRunLifecycle(
		input: UpdateWorkflowAgentRunLifecycleInput,
	): Promise<{ id: string; status: WorkflowAgentRunStatus }>;
}

export type WorkflowPlanArtifactStatus =
	| "draft"
	| "approved"
	| "superseded"
	| "executed"
	| "failed";

export type WorkflowPlanArtifactInput = {
	artifactRef: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	goal: string;
	planJson: Record<string, unknown>;
	planMarkdown?: string | null;
	sourcePrompt?: string | null;
	artifactType?: string | null;
	status?: WorkflowPlanArtifactStatus;
	workspaceRef?: string | null;
	clonePath?: string | null;
	metadata?: Record<string, unknown> | null;
};

export type WorkflowPlanArtifactRecord = {
	artifactRef: string;
	workflowExecutionId: string;
	workflowId: string;
	userId: string | null;
	nodeId: string;
	workspaceRef: string | null;
	clonePath: string | null;
	artifactType: string;
	artifactVersion: number;
	status: WorkflowPlanArtifactStatus;
	goal: string;
	planJson: Record<string, unknown>;
	planMarkdown: string | null;
	sourcePrompt: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: Date;
	updatedAt: Date;
};

export interface WorkflowPlanArtifactStore {
	upsertPlanArtifact(input: WorkflowPlanArtifactInput): Promise<{
		artifactRef: string;
		storageBackend: "workflow_plan_artifacts";
		artifactType: string;
		status: WorkflowPlanArtifactStatus;
	}>;
	listPlanArtifactsByExecutionId(
		executionId: string,
	): Promise<WorkflowPlanArtifactRecord[]>;
	updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: WorkflowPlanArtifactStatus;
		metadata?: Record<string, unknown> | null;
	}): Promise<{ artifactRef: string; status: WorkflowPlanArtifactStatus }>;
	getPlanArtifact(artifactRef: string): Promise<WorkflowPlanArtifactRecord | null>;
}

export interface LegacyAgentPlanReaderPort {
	getPlan(executionId: string): Promise<string | null>;
}

export type TraceLinkTarget = {
	entityType: "workflow_execution" | "session";
	entityId: string;
	projectId: string | null;
	externalRunId?: string | null;
	externalExperimentId?: string | null;
};

export type UpsertTraceLineageLinksInput = {
	traceId: string;
	targets: TraceLinkTarget[];
	source?: string;
	attrs?: Record<string, string>;
};

export interface TraceLineageStore {
	getTraceTargetsForExecution(executionId: string): Promise<TraceLinkTarget[]>;
	upsertTraceLineageLinks(
		input: UpsertTraceLineageLinksInput,
	): Promise<{ recorded: number; sourceKeys: string[] }>;
}

export type WorkflowStartRequest = {
	orchestratorUrl: string;
	workflow: Record<string, unknown>;
	workflowId: string;
	triggerData: Record<string, unknown>;
	dbExecutionId: string;
	headers: HeadersInit;
	traceContext?: Record<string, string | undefined>;
	resumeFromNode?: string;
	workspaceExecutionId?: string;
	seedWorkspaceFrom?: string;
};

export interface WorkflowScheduler {
	startSwWorkflow(input: WorkflowStartRequest): Promise<{ instanceId?: string }>;
}

export type WorkflowApprovalEventInput = {
	instanceId: string;
	eventType: string;
	approvedBy: string;
};

export type WorkflowApprovalEventResult =
	| { ok: true }
	| { ok: false; status: number; detail: string };

export interface WorkflowApprovalEventPort {
	raiseApprovalEvent(
		input: WorkflowApprovalEventInput,
	): Promise<WorkflowApprovalEventResult>;
}

export type WorkflowRunStartInput = {
	workflowId?: string;
	workflowName?: string;
	userId?: string;
	triggerData: Record<string, unknown>;
	executionId?: string;
	idempotent?: boolean;
	resumeFromNode?: string;
	seedWorkspaceFrom?: string;
	rerunOfExecutionId?: string;
	rerunSourceInstanceId?: string;
	triggerSource?: string;
};

export type WorkflowRunStartResult =
	| {
			ok: true;
			executionId: string;
			instanceId: string | null;
			workflowId?: string;
			workflowName?: string;
			reused?: boolean;
	  }
	| { ok: false; status: number; error: string };

export interface WorkflowRunStarterPort {
	startWorkflowRun(input: WorkflowRunStartInput): Promise<WorkflowRunStartResult>;
}

export interface WorkflowSpecValidatorPort {
	isServerlessWorkflow(spec: unknown): boolean;
}

export type WorkflowExecutionCoordinatorOwner = {
	kind: "benchmarkRun" | "evalRun" | string;
	runId: string;
};

export interface WorkflowExecutionCoordinatorOwnerPort {
	getCoordinatorOwner(
		executionIdOrInstanceId: string,
	): Promise<WorkflowExecutionCoordinatorOwner | null>;
}

export type WorkflowExecutionLifecycleAccessResult =
	| { status: "ok"; active: boolean }
	| { status: "not_found" };

export type WorkflowExecutionLifecycleStopMode =
	| "interrupt"
	| "terminate"
	| "purge"
	| "reset";

export type WorkflowExecutionLifecycleStopResult = {
	notFound?: boolean;
	confirmed: boolean;
	state?: "confirmed" | "stopping" | string;
	retryable?: boolean;
	[key: string]: unknown;
};

export type WorkflowExecutionLifecycleStopStatus = {
	state: string;
};

export interface WorkflowExecutionLifecycleControllerPort {
	checkExecutionAccess(input: {
		executionId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkflowExecutionLifecycleAccessResult>;
	stopExecution(
		executionId: string,
		opts: {
			mode: WorkflowExecutionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	): Promise<WorkflowExecutionLifecycleStopResult>;
	confirmExecutionStop(
		executionId: string,
	): Promise<WorkflowExecutionLifecycleStopStatus>;
}

export interface WorkflowExecutionReadModelPort {
	loadExecutionReadModel(input: {
		executionId: string;
		refreshRuntime: boolean;
		includeAgentEvents: boolean;
	}): Promise<unknown | null>;
	serializeExecutionReadModel(
		model: unknown,
		options: { compact: boolean; includeAgentEvents: boolean },
	): Record<string, unknown>;
}

export type CliPreviewTarget = { podIP: string; runtime?: string | null };

export type CliPreviewResolveResult =
	| { ok: true; target: CliPreviewTarget }
	| { ok: false; status: number; message: string };

export type ExecutionCliPreviewTarget = {
	podIP: string;
	appId: string;
	sharedWorkspaceKey: string;
	reused: boolean;
};

export type ExecutionCliPreviewResolveResult =
	| { ok: true; target: ExecutionCliPreviewTarget }
	| { ok: false; status: number; message: string }
	| { ok: false; provisioning: true; status: 202; message: string };

export type ExecutionPreviewBackend = "cli" | "openshell" | null;

export interface CliPreviewGatewayPort {
	defaultPort: number;
	resolveSessionTarget(
		sessionId: string,
		projectId?: string | null,
	): Promise<CliPreviewResolveResult>;
	resolveExecutionTarget(
		executionId: string,
		projectId?: string | null,
		opts?: { readyBudgetSeconds?: number; provisionIfMissing?: boolean },
	): Promise<ExecutionCliPreviewResolveResult>;
	startPreview(
		podIP: string,
		opts: { cwd: string; port: number; previewCommand?: string },
	): Promise<{ ready: boolean; log: string }>;
	proxyPreview(input: {
		podIP: string;
		port: number;
		request: Request;
		restPath: string;
		search: string;
		proxyBasePath: string;
	}): Promise<Response>;
	executionPreviewBackend(executionId: string): Promise<ExecutionPreviewBackend>;
}

export type ExecutionSandboxPreviewInfo = {
	executionId: string;
	workspaceRef: string;
	sandboxName: string;
	rootPath: string;
	workingDir: string;
	provider: string;
	kept: boolean;
};

export type ExecutionWorkspaceRouteInfo = {
	projectId: string;
	userId: string;
	workspaceSlug: string;
};

export interface SandboxPreviewGatewayPort {
	getSandboxPreviewInfo(
		executionId: string,
	): Promise<ExecutionSandboxPreviewInfo | null>;
	runtimeFetch(path: string, options?: RequestInit): Promise<Response>;
}

export interface EventBus {
	publish(topic: string, payload: unknown): Promise<void>;
}

export type GoalFlowGoalRecord = {
	sessionId: string;
	goalId: string;
	objective: string;
	status: string;
	iterations: number;
	maxIterations: number;
	tokensUsed: number;
	tokenBudget: number | null;
	stopReason: string | null;
	acceptanceCriteria: string[] | null;
	evidencePlan: { commands?: string[] } | null;
	createdAt: Date;
	completedAt: Date | null;
};

export type GoalFlowEventRecord = {
	sequence: number;
	type: string;
	data: Record<string, unknown>;
	createdAt: Date;
};

export interface GoalFlowReadStore {
	getCurrentGoalForSessions(sessionIds: string[]): Promise<GoalFlowGoalRecord | null>;
	listGoalFlowEvents(input: {
		sessionId: string;
		limit?: number;
	}): Promise<GoalFlowEventRecord[]>;
}

export type ResolveSecretOptions = {
	store?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
};

export interface CredentialStore {
	resolveSecret(
		name: string,
		options?: ResolveSecretOptions,
	): Promise<Record<string, unknown>>;
}

export type CreateSessionForkInput = {
	agentId: string;
	agentVersion?: number | null;
	environmentId?: string | null;
	environmentVersion?: number | null;
	vaultIds: string[];
	title: string;
	userId: string;
	projectId?: string | null;
};

export type AddSessionResourceInput = {
	type: SessionResourceType;
	fileId?: string;
	mountPath?: string;
	repoUrl?: string;
	checkoutRef?: string;
	authTokenCredentialId?: string;
	appConnectionExternalId?: string;
};

export type AddSessionResourceResult =
	| {
			status: "created";
			resource: SessionResource;
			session: SessionDetail;
	  }
	| { status: "not_found" };

export type SessionListInput = {
	userId?: string;
	projectId?: string | null;
	agentId?: string;
	status?: SessionStatus;
	includeArchived?: boolean;
	source?: "direct" | "workflow" | "api";
	workflowId?: string;
	executionId?: string;
	q?: string;
	limit?: number;
};

export type CreateSessionRecordInput = {
	id?: string;
	agentId: string;
	agentVersion?: number;
	environmentId?: string;
	environmentVersion?: number;
	vaultIds?: string[];
	title?: string;
	userId: string;
	projectId?: string | null;
	workflowExecutionId?: string | null;
	parentExecutionId?: string | null;
	sandboxName?: string | null;
	resumedFromSessionId?: string | null;
};

export interface SessionRepository {
	listSessions(filter?: SessionListInput): Promise<SessionSummary[]>;
	getSession(id: string): Promise<SessionDetail | null>;
	createSession(input: CreateSessionRecordInput): Promise<SessionDetail>;
	updateSessionTitle(input: {
		id: string;
		title: string;
	}): Promise<SessionDetail | null>;
	archiveSession(id: string): Promise<boolean>;
	deleteSession(id: string): Promise<boolean>;
	listSessionResources(sessionId: string): Promise<SessionResource[]>;
	addSessionResource(input: {
		sessionId: string;
		resource: AddSessionResourceInput;
	}): Promise<SessionResource>;
	attachWorkspaceSandbox(input: {
		sessionId: string;
		workspaceSandboxName: string;
	}): Promise<void>;
	recordSandboxProvisioningError(input: {
		sessionId: string;
		errorMessage: string;
	}): Promise<void>;
	removeSessionResource(input: {
		sessionId: string;
		resourceId: string;
	}): Promise<boolean>;
	getSessionProvisioningContext(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionProvisioningContext | null>;
	getSessionContextUsage(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionContextUsageReadModel | null>;
	getSessionRuntimeDebugTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionRuntimeDebugTarget | null>;
	getBrowserSessionTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserTarget | null>;
	listCliWorkspaceSessionCandidates(input: {
		executionId: string;
		limit: number;
	}): Promise<CliWorkspaceSessionCandidateRecord[]>;
	getWorkflowEnsureSession(sessionId: string): Promise<WorkflowEnsureSessionRecord | null>;
	createWorkflowEnsureSession(input: CreateWorkflowEnsureSessionInput): Promise<void>;
	updateWorkflowEnsureSessionRuntime(
		input: UpdateWorkflowEnsureSessionRuntimeInput,
	): Promise<void>;
	listTerminalWorkflowSessionRuntimeHosts(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowSessionRuntimeHostRecord[]>;
	createSessionFork(input: CreateSessionForkInput): Promise<{ id: string }>;
	getPeerSession(sessionId: string): Promise<PeerSessionRecord | null>;
	createPeerSession(input: CreatePeerSessionInput): Promise<PeerSessionRecord>;
	findSessionIdByDaprInstanceId(instanceId: string): Promise<string | null>;
	resolveSessionIdForProvisioningEvent(input: {
		runtimeAppId?: string | null;
		sessionId?: string | null;
	}): Promise<string | null>;
	getSessionFileOwner(
		sessionId: string,
	): Promise<{ id: string; userId: string; projectId: string | null } | null>;
	getSessionWorkflowContext(sessionId: string): Promise<SessionWorkflowContext | null>;
	updateSessionStatus(input: UpdateSessionStatusInput): Promise<void>;
	updateSessionStatusUnlessTerminated(
		input: UpdateSessionStatusUnlessTerminatedInput,
	): Promise<void>;
}

export type SessionProvisioningPhase =
	| "queued"
	| "admitted"
	| "scheduling"
	| "pulling"
	| "initializing"
	| "starting"
	| "running"
	| "failed"
	| "unknown";

export type SessionProvisioningMark = {
	phase: string;
	at: string;
	durationMs: number | null;
};

export type SessionProvisioningReadModel = {
	phase: SessionProvisioningPhase;
	label: string;
	detail: string | null;
	podName: string | null;
	podPhase: string | null;
	timeline?: SessionProvisioningMark[];
	source?: "observer" | "pod";
};

export type SessionProvisioningContext = {
	id: string;
	status: SessionStatus;
	runtimeAppId: string | null;
	projectId: string | null;
};

export type SessionProvisioningResult =
	| { status: "ok"; data: SessionProvisioningReadModel }
	| { status: "not_found" };

export interface SessionProvisioningReader {
	getSessionProvisioning(input: {
		sessionId: string;
		runtimeAppId?: string | null;
	}): Promise<SessionProvisioningReadModel>;
}

export interface SessionRuntimeConfigReader {
	getSessionRuntimeConfig(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<RuntimeConfigCloudEvent | null>;
}

export type SessionPermissionMode = "bypass" | "default";

export type SessionAgentConfigPatch = {
	modelSpec?: string;
	role?: string;
	goal?: string;
	systemPrompt?: string;
	instructions?: string[];
	styleGuidelines?: string[];
	toolChoice?: AgentToolChoice;
	permissionMode?: SessionPermissionMode;
	builtinTools?: string[];
	tools?: string[];
	allowedTools?: string[];
	mcpConnectionMode?: AgentConfig["mcpConnectionMode"];
	mcpServers?: McpServerProfileConfig[];
	mcpConnectionWarnings?: string[];
	skills?: AgentSkillConfig[];
	plugins?: string[];
	maxTurns?: number;
	maxIterations?: number;
	timeoutMinutes?: number;
	temperature?: number;
};

export type SessionAgentConfigPatchResult =
	| {
			ok: true;
			status: number;
			patch: SessionAgentConfigPatch;
	  }
	| {
			ok: false;
			status: number;
			error?: string;
			patch?: SessionAgentConfigPatch;
	  };

export interface SessionAgentConfigCommandPort {
	raiseSessionAgentConfigPatch(input: {
		sessionId: string;
		patch: unknown;
	}): Promise<SessionAgentConfigPatchResult>;
}

export type SessionContextUsageEventStats = {
	total: number;
	totalBytes: number;
	llmTurns: number;
};

export type SessionContextUsageReadModel = {
	sessionId: string;
	usage: SessionUsage;
	activeContext: Record<string, unknown> | null;
	lastProviderContext: Record<string, unknown> | null;
	events: SessionContextUsageEventStats;
};

export type SessionBrowserTarget = {
	sessionId: string;
	agentSlug: string;
};

export type SessionBrowserConsoleEntry = {
	level: string;
	text: string;
};

export type SessionBrowserState = {
	pageUrl: string | null;
	pageTitle: string | null;
	consoleTail: SessionBrowserConsoleEntry[];
	lastUpdatedAt: string;
};

export type SessionBrowserScreenshot = {
	jpeg: Uint8Array;
	contentType: "image/jpeg";
};

export type SessionBrowserResult<T> =
	| { status: "ok"; data: T }
	| { status: "not_found" }
	| { status: "not_ready" };

export interface BrowserRuntimeClient {
	getState(input: {
		agentSlug: string;
	}): Promise<Omit<SessionBrowserState, "lastUpdatedAt"> | null>;
	takeScreenshot(input: { agentSlug: string }): Promise<{ jpeg: Uint8Array } | null>;
}

export interface SessionBrowserService {
	getState(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserResult<SessionBrowserState>>;
	takeScreenshot(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserResult<SessionBrowserScreenshot>>;
}

export type SessionWorkflowContext = {
	workflowExecutionId: string | null;
	parentExecutionId: string | null;
	daprInstanceId: string | null;
};

export type UpdateSessionStatusInput = {
	id: string;
	status: SessionStatus;
	stopReason?: SessionStopReason | null;
	usage?: SessionUsage;
	errorMessage?: string | null;
	markCompleted?: boolean;
	pauseRequestedAt?: Date | null;
};

export type UpdateSessionStatusUnlessTerminatedInput = Omit<
	UpdateSessionStatusInput,
	"status" | "markCompleted" | "pauseRequestedAt"
> & {
	status: Exclude<SessionStatus, "terminated" | "paused">;
};

export type CliWorkspaceSessionCandidateRecord = {
	id: string;
	userId: string | null;
	projectId: string | null;
	runtimeAppId: string | null;
	runtimeSandboxName: string | null;
	agentSlug: string;
	agentRuntime: string | null;
	agentRuntimeAppId: string | null;
};

export type CliWorkspaceCommandCandidate = {
	sessionId: string;
	userId: string | null;
	projectId: string | null;
	appId: string;
	invokeTarget: string;
	runtimeSandboxName: string | null;
	source: "persisted" | "agent";
	agentSlug: string;
	agentRuntime: string | null;
};

export type SessionRuntimeTargetSource = "persisted" | "agent" | "legacy";

export type SessionRuntimeDebugTarget = {
	appId: string;
	invokeTarget: string;
	runtimeSandboxName: string | null;
	source: SessionRuntimeTargetSource;
	agentSlug: string | null;
	agentRuntime: string | null;
};

export type WorkflowEnsureSessionRecord = {
	id: string;
	agentId: string;
	agentVersion: number | null;
	vaultIds: string[];
	workflowExecutionId: string | null;
	sandboxName: string | null;
	runtimeAppId: string | null;
	runtimeSandboxName: string | null;
};

export type CreateWorkflowEnsureSessionInput = {
	id: string;
	title: string;
	agentId: string;
	agentVersion: number | null;
	vaultIds: string[];
	userId: string;
	projectId: string | null;
	sandboxName: string;
	workflowExecutionId: string | null;
	parentExecutionId: string | null;
};

export type UpdateWorkflowEnsureSessionRuntimeInput = {
	sessionId: string;
	runtimeAppId: string;
	runtimeSandboxName: string | null;
};

export type WorkflowSessionRuntimeHostRecord = {
	sessionId: string;
	runtimeAppId: string;
};

export type PeerSessionRecord = {
	id: string;
	agentId: string;
	agentVersion: number | null;
	environmentId: string | null;
	environmentVersion: number | null;
	vaultIds: string[];
	daprInstanceId: string | null;
	natsSubject: string | null;
};

export type CreatePeerSessionInput = {
	id: string;
	agentId: string;
	title: string;
	userId: string;
	projectId: string | null;
	parentExecutionId: string | null;
};

export type PeerAgentOwner = {
	userId: string | null;
	projectId: string | null;
};

export type WorkflowAgentRuntimeIdentity = {
	agentId: string;
	slug: string;
	runtimeAppId: string | null;
	appId: string;
};

export type WorkflowPublishedAgent = {
	agentId: string;
	agentVersion: number;
	agentSlug: string | null;
	agentAppId: string | null;
	mlflowUri: string | null;
	mlflowModelName: string | null;
	mlflowModelVersion: string | null;
};

export type WorkflowPublishedAgentResolutionResult =
	| {
			ok: true;
			agent: WorkflowPublishedAgent;
	  }
	| {
			ok: false;
			status: 400 | 403;
			message: string;
	  };

export type PeerCallableAgent = {
	slug: string;
	agentId: string;
	version: number;
	appId: string;
	team: string;
	registryKey: string;
};

export type PeerAgentDispatchContext = {
	agentConfig: AgentConfig;
	environmentConfig: Record<string, unknown> | null;
	callableAgents: PeerCallableAgent[];
	registryTeam: string | null;
};

export type SessionControlSettingsAgent = {
	id: string;
	slug: string;
	version: number;
	config: AgentConfig;
};

export type SessionControlSettingsEnvironment = {
	id: string;
	slug: string;
	version: number;
	config: Record<string, unknown>;
};

export type SessionControlSettingsReferences = {
	agent: SessionControlSettingsAgent | null;
	environment: SessionControlSettingsEnvironment | null;
};

export type SessionControlSettingsReadModel = {
	session: SessionDetail;
	agent: SessionControlSettingsAgent | null;
	environment: SessionControlSettingsEnvironment | null;
};

export type SessionRuntimeCliAuthCredentialKind =
	| "env_token"
	| "file"
	| "file_bundle"
	| "device_login";

export type SessionRuntimeCliAuthReadModel = {
	provider: string;
	credentialKind: SessionRuntimeCliAuthCredentialKind;
	setupCommand: string | null;
};

export type SessionRuntimeResourceUsage = {
	name: string;
	cpuMillicores: number;
	memoryMiB: number;
};

export type SessionRuntimeResourceRequests = {
	cpuMillicores: number;
	memoryMiB: number;
};

export type SessionRuntimeComputeReadModel = {
	podName: string | null;
	usage: SessionRuntimeResourceUsage | null;
	requests: SessionRuntimeResourceRequests | null;
};

export type SessionRuntimePodTarget = {
	name: string;
	namespace: string;
	podIP: string | null;
	containers: Array<{ name: string; ready: boolean }>;
};

export interface SessionRuntimePodLocator {
	getSessionRuntimePod(
		target: Pick<SessionRuntimeDebugTarget, "appId" | "agentSlug">,
	): Promise<SessionRuntimePodTarget | null>;
	getAgentWorkflowHostPod(appId: string): Promise<SessionRuntimePodTarget | null>;
}

export interface SessionRuntimeCapabilityReader {
	isShellContainerAllowed(container: string): boolean;
	hasInteractiveTerminal(runtime: string | null): boolean;
}

export type SessionRuntimeFlagsReadModel = {
	agentSlug: string | null;
	runtimeAppId: string;
	runtimeSandboxName: string | null;
	browserSidecarEnabled: boolean;
	browserMcpAvailable: boolean;
	shellAvailable: boolean;
	shellContainers: string[];
	interactiveTerminal: boolean;
	nativeGoalAvailable: boolean;
	cliLabel: string | null;
	phase: string;
};

export interface SessionRuntimeStatusReader {
	getSessionRuntimeCompute(
		target: SessionRuntimeDebugTarget,
	): Promise<SessionRuntimeComputeReadModel>;
	getSessionRuntimeFlags(
		target: SessionRuntimeDebugTarget,
	): Promise<SessionRuntimeFlagsReadModel>;
}

export type NewSessionPageReadModel = {
	cliAuthByRuntime: Record<string, SessionRuntimeCliAuthReadModel>;
};

export interface RuntimeRegistryReader {
	listSessionRuntimeCliAuth(): Promise<
		Record<string, SessionRuntimeCliAuthReadModel>
	>;
}

export type DevPreviewServiceReadModel = {
	service: string;
	primaryCluster: string;
	fallbackCluster: string;
	deliveryRole: string;
	previewTier: string;
	needsDapr: boolean;
	port: number;
	syncMode: string;
	repoUrl: string;
	repoSubdir: string;
	tailnetHost: string;
};

export type DevEnvironmentSummaryReadModel = {
	executionId: string;
	workspaceRef: string;
	service: string;
	browseUrl: string | null;
	podIP: string | null;
	port: number | null;
	syncUrl: string | null;
	ready: boolean;
	needsDapr: boolean;
	daprAppId: string | null;
	sandboxName: string | null;
	sessionId: string | null;
	sessionUrl: string | null;
	runStatus: string | null;
	createdAt: string;
};

export type DevPreviewHubReadModel = {
	services: DevPreviewServiceReadModel[];
	devWorkflowId: string | null;
	devWorkflowName: string;
};

export interface DevEnvironmentReadRepository {
	listServices(): DevPreviewServiceReadModel[];
	listDevEnvironments(
		projectId: string | null | undefined,
	): Promise<DevEnvironmentSummaryReadModel[]>;
	getDevEnvironmentOrPending(input: {
		executionId: string;
		projectId: string | null | undefined;
	}): Promise<DevEnvironmentSummaryReadModel | null>;
	resolveCanonicalExecutionId(input: { executionId: string }): Promise<string>;
}

export interface PeerAgentResolver {
	resolvePeerAgentOwner(peerAgentId: string): Promise<PeerAgentOwner | null>;
	resolvePeerAgentDispatchContext(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<PeerAgentDispatchContext | null>;
}

export interface WorkflowAgentReadRepository {
	getWorkflowAgentRuntimeIdentity(
		agentId: string,
	): Promise<WorkflowAgentRuntimeIdentity | null>;
	resolvePublishedWorkflowAgentForEnsure(input: {
		agentId: string | null;
		agentVersion?: number | null;
		projectId?: string | null;
	}): Promise<WorkflowPublishedAgentResolutionResult | null>;
	resolveSessionControlSettingsReferences(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<SessionControlSettingsReferences>;
}

export interface WorkflowEphemeralAgentStore {
	findOrCreateWorkflowEphemeralAgent(input: {
		workflowId: string;
		nodeId: string;
		agentConfig: AgentConfig;
		userId: string;
	}): Promise<{ agentId: string; agentVersion: number }>;
}

export interface AgentRuntimeSyncPort {
	syncAgentRuntime(agentId: string): Promise<void>;
}

export type SessionForkBaseAgent = {
	id: string;
	slug: string;
	name: string;
	config: AgentConfig;
};

export interface SessionExperimentAgentStore {
	resolveSessionForkBaseAgent(input: {
		agentId: string;
		agentVersion?: number | null;
	}): Promise<SessionForkBaseAgent | null>;
	findOrCreateSessionExperimentAgent(input: {
		baseAgentId: string;
		baseAgentSlug: string;
		baseAgentName: string;
		agentConfig: AgentConfig;
		userId: string;
		projectId?: string | null;
	}): Promise<{ agentId: string; agentVersion: number }>;
}

export type EnsurePeerSessionInput = {
	sessionId: string;
	peerAgentId: string;
	prompt: string;
	parentSessionId?: string | null;
	parentInstanceId?: string | null;
	title?: string | null;
};

export type EnsurePeerSessionResult =
	| {
			ok: true;
			session: PeerSessionRecord;
			reused: boolean;
	  }
	| {
			ok: false;
			status: 404 | 500;
			message: string;
	  };

export type AppendSessionEventInput = {
	type: string;
	data?: Record<string, unknown>;
	processedAt?: Date | null;
	sourceEventId?: string | null;
	producerId?: string | null;
	producerEpoch?: string | null;
};

export type ListSessionEventsInput = {
	afterSequence?: number;
	atOrBeforeSequence?: number;
	limit?: number;
	preview?: boolean;
};

export interface SessionEventLog {
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope>;
	getSessionEvent(input: {
		sessionId: string;
		eventId: string;
	}): Promise<SessionEventEnvelope | null>;
	listSessionEvents(
		sessionId: string,
		input?: ListSessionEventsInput,
	): Promise<SessionEventEnvelope[]>;
}

export interface SessionRuntimeEventRaiser {
	raiseSessionUserEvents(sessionId: string, events: UserEvent[]): Promise<void>;
}

export type SessionRepositoryMountTarget = {
	executionId: string;
	workspaceRef: string | null;
	rootPath?: string | null;
};

export interface SessionRepositoryMounter {
	mountSessionRepositories(
		sessionId: string,
		target: SessionRepositoryMountTarget,
	): Promise<void>;
	mountSessionRepository(
		sessionId: string,
		resource: SessionResource,
		target: SessionRepositoryMountTarget,
	): Promise<void>;
}

export interface SessionWorkflowSpawner {
	spawnSessionWorkflow(sessionId: string): Promise<{
		instanceId: string;
		natsSubject: string;
	}>;
}

export type SessionLifecycleAccessResult =
	| { status: "ok"; active: boolean }
	| { status: "not_found" };

export type SessionLifecyclePauseResult =
	| { ok: true }
	| {
			ok: false;
			notFound?: boolean;
			reason?: "not_active" | "no_runtime" | string;
	  };

export type SessionLifecycleResumeResult =
	| { ok: true }
	| {
			ok: false;
			notFound?: boolean;
			reason?: "no_runtime" | string;
	  };

export type SessionLifecycleStopMode =
	| "interrupt"
	| "terminate"
	| "purge"
	| "reset";

export type SessionLifecycleStopResult = {
	notFound?: boolean;
	confirmed: boolean;
	state?: "confirmed" | "stopping" | string;
	retryable?: boolean;
	[key: string]: unknown;
};

export type SessionLifecycleStopStatus = {
	state: string;
};

export type SessionCoordinatorOwner = {
	kind: "benchmarkRun" | "evalRun";
	runId: string;
};

export interface SessionLifecycleController {
	checkSessionAccess(input: {
		sessionId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<SessionLifecycleAccessResult>;
	pauseSession(sessionId: string): Promise<SessionLifecyclePauseResult>;
	resumeSession(sessionId: string): Promise<SessionLifecycleResumeResult>;
	stopSession(
		sessionId: string,
		opts: {
			mode: SessionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	): Promise<SessionLifecycleStopResult>;
	confirmSessionStop(sessionId: string): Promise<SessionLifecycleStopStatus>;
	getCoordinatorOwner(sessionId: string): Promise<SessionCoordinatorOwner | null>;
	pauseSessionGoal(sessionId: string): Promise<void>;
}

export type SessionSandboxDeleteKind = "runtime" | "workspace";

export type SessionSandboxDeleteResult = {
	name: string;
	kind: SessionSandboxDeleteKind;
	status: "deleted" | "missing" | "error";
	error?: string;
};

export interface SessionSandboxDestroyer {
	deleteRuntimeSandbox(name: string): Promise<SessionSandboxDeleteResult>;
	deleteWorkspaceSandbox(name: string): Promise<SessionSandboxDeleteResult>;
}

export type SessionMcpAgentConfig = {
	mcpServers?: AgentConfig["mcpServers"];
};

export interface SessionMcpAgentConfigReader {
	getAgentMcpConfig(input: {
		agentId: string;
		agentVersion?: number | null;
	}): Promise<SessionMcpAgentConfig | null>;
}

export interface SessionMcpCredentialStatusReader {
	hasCredentialForMcpServer(input: {
		vaultIds: string[];
		mcpServerUrl: string;
	}): Promise<boolean>;
}

export type SessionGoalStatus =
	| "active"
	| "paused"
	| "budget_limited"
	| "complete";

export type SessionGoalRecord = {
	id: string;
	sessionId: string;
	goalId: string;
	objective: string;
	status: SessionGoalStatus | string;
	tokenBudget: number | null;
	tokensUsed: number;
	timeUsedSeconds: number;
	iterations: number;
	maxIterations: number;
	acceptanceCriteria: string[] | null;
	evidencePlan: { commands?: string[] } | null;
	budgetSteeredAt: Date | null;
	lastContinuationAt: Date | null;
	stopReason: string | null;
	workflowExecutionId: string | null;
	createdAt: Date;
	updatedAt: Date;
	completedAt: Date | null;
};

export type CreateSessionGoalInput = {
	sessionId: string;
	objective: string;
	tokenBudget?: number | null;
	maxIterations?: number;
	workflowExecutionId?: string | null;
	acceptanceCriteria?: string[] | null;
	evidencePlan?: { commands?: string[] } | null;
};

export interface SessionGoalStore {
	getCurrentGoal(sessionId: string): Promise<SessionGoalRecord | null>;
	createOrReplaceGoal(input: CreateSessionGoalInput): Promise<SessionGoalRecord>;
	markGoalComplete(sessionId: string): Promise<SessionGoalRecord | null>;
	pauseGoal(sessionId: string): Promise<SessionGoalRecord | null>;
}

export interface SessionGoalLoopDriver {
	kickSessionGoalLoop(
		sessionId: string,
		opts?: { kickoff?: boolean; fromStopHook?: boolean },
	): Promise<void>;
}

export interface SessionGoalHarnessResolver {
	sessionHasNativeGoalHarness(sessionId: string): Promise<boolean>;
	decideGoalHarness(
		rawObjective: string,
		hasNativeHarness: boolean,
	): { native: boolean; objective: string };
}

export interface SessionGoalScopeGuard {
	checkSessionScope(input: {
		sessionId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<"ok" | "not_found">;
}

export interface SessionUserEventCommandPort {
	appendSessionUserEvents(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
		events: UserEvent[];
	}): Promise<"ok" | "not_found">;
}

export type PersistCodeCheckpointInput = {
	workflowExecutionId: string;
	workflowAgentRunId?: string | null;
	parentExecutionId?: string | null;
	daprInstanceId: string;
	sourceEventId: string;
	seq?: number | null;
	toolName: string;
	nodeId?: string | null;
	payload: unknown;
};

export type WorkflowCodeCheckpointReadModel = {
	id: string;
	workflowExecutionId: string;
	workflowAgentRunId: string | null;
	parentExecutionId: string | null;
	daprInstanceId: string;
	workspaceRef: string | null;
	sandboxName: string | null;
	repoPath: string;
	nodeId: string | null;
	sourceEventId: string;
	seq: number | null;
	toolName: string;
	checkpointKind: "tool_mutation";
	beforeSha: string | null;
	afterSha: string | null;
	remoteUrl: string | null;
	remoteRef: string | null;
	remoteStatus: string | null;
	remoteError: string | null;
	remotePushedAt: string | null;
	changedFiles: Array<Record<string, unknown>>;
	fileCount: number;
	status: "created" | "no_changes" | "skipped" | "error";
	error: string | null;
	metadata: Record<string, unknown> | null;
	createdAt: string;
};

export interface WorkflowCodeCheckpointStore {
	persistFromAgentEvent(input: PersistCodeCheckpointInput): Promise<void>;
	listForExecution(
		executionId: string,
	): Promise<WorkflowCodeCheckpointReadModel[]>;
}

export type WorkflowCodeCheckpointOperationResult = Record<string, unknown>;

export interface WorkflowCodeCheckpointWorkspacePort {
	diffCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		path?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult>;
	restoreCheckpoint(input: {
		executionId: string;
		checkpointId: string;
		sandboxName: string;
		repoPath?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult>;
}

export interface EvaluationArtifactStore {
	recordCodeCheckpointWarning(input: {
		workflowExecutionId: string;
		sourceEventId: string;
		checkpoint: Record<string, unknown>;
	}): Promise<void>;
}

export interface SessionTraceLifecycleStore {
	createInteractiveSessionTraceRun?(input: {
		sessionId: string;
		title?: string | null;
		projectId?: string | null;
		userId?: string | null;
		agentId: string;
		agentName?: string | null;
		agentSlug?: string | null;
		agentVersion?: number | null;
		agentAppId?: string | null;
		activeModelId?: string | null;
		activeModelName?: string | null;
		activeModelUri?: string | null;
		existingRunId?: string | null;
	}): Promise<{
		experimentId: string;
		runId: string;
		parentRunId?: string | null;
		mlflowSessionId?: string | null;
	} | null>;
	patchInteractiveSessionTraces(input: {
		sessionId: string;
		status: "OK" | "ERROR";
	}): Promise<void>;
}

export type SessionCommandAgent = {
	id: string;
	name: string;
	slug: string;
	version: number;
	projectId?: string | null;
	config: AgentConfig;
	runtime: string;
	runtimeAppId: string | null;
	mlflowModelVersion: string | null;
	mlflowModelName: string | null;
	mlflowUri: string | null;
};

export interface SessionAgentResolver {
	resolveSessionAgent(input: {
		agentId: string;
		agentVersion?: number | null;
	}): Promise<SessionCommandAgent | null>;
}

export interface SessionAgentSlugResolver {
	resolveSessionAgentIdBySlug(slug: string): Promise<string | null>;
}

export type AgentCatalogListInput = {
	q?: string;
	tag?: string;
	includeArchived?: boolean;
	includeEphemeral?: boolean;
	projectId?: string;
};

export type AgentCatalogCreateInput = {
	slug?: string;
	name: string;
	description?: string | null;
	avatar?: string | null;
	tags?: string[];
	runtime?: AgentRuntime;
	sourceTemplateSlug?: string | null;
	sourceTemplateVersion?: number | null;
	createdBy?: string | null;
	projectId?: string | null;
	config: AgentConfig;
};

export type AgentCatalogUpdateInput = {
	name?: string;
	description?: string | null;
	avatar?: string | null;
	tags?: string[];
	runtime?: AgentRuntime;
	environmentId?: string | null;
	environmentVersion?: number | null;
	defaultVaultIds?: string[];
	config?: AgentConfig;
	changelog?: string | null;
	publishedBy?: string | null;
};

export type AgentCatalogWriteResult =
	| { ok: true; agent: AgentDetail }
	| { ok: false; reason: "invalid_config"; message: string };

export type AgentCatalogUpdateResult =
	| { ok: true; agent: AgentDetail }
	| { ok: false; reason: "not_found" }
	| { ok: false; reason: "invalid_config"; message: string };

export type AgentCatalogDuplicateInput = {
	name?: string;
	description?: string | null;
	createdBy?: string | null;
	projectId?: string | null;
};

export type AgentCatalogVersionDetail = {
	summary: AgentVersionSummary;
	config: AgentConfig;
};

export type AgentCatalogUsage = {
	workflowId: string;
	workflowName: string;
	nodeIds: string[];
};

export type AgentCatalogUsageCounts = Record<
	string,
	{ workflowCount: number; nodeCount: number }
>;

export type AgentCompiledCapabilities = Record<string, unknown>;

export type AgentRegistryStatus =
	| "unregistered"
	| "registered"
	| "failed"
	| "archiving"
	| "archived";

export type AgentRegistrySyncResult = {
	status: AgentRegistryStatus;
	syncedAt: string | null;
	error: string | null;
	team: string | null;
	key: string | null;
};

export type AgentRegistryView = AgentRegistrySyncResult & {
	store: string;
	dualWriteEnabled: boolean;
	metadata?: unknown | null;
};

export interface AgentCatalogRepository {
	listAgents(input: AgentCatalogListInput): Promise<AgentSummary[]>;
	getAgent(id: string): Promise<AgentDetail | null>;
	createAgent(input: AgentCatalogCreateInput): Promise<AgentCatalogWriteResult>;
	updateAgent(
		id: string,
		input: AgentCatalogUpdateInput,
	): Promise<AgentCatalogUpdateResult>;
	archiveAgent(id: string): Promise<boolean>;
	duplicateAgent(
		id: string,
		input: AgentCatalogDuplicateInput,
	): Promise<AgentDetail | null>;
	listVersions(agentId: string): Promise<AgentVersionSummary[]>;
	getVersion(
		agentId: string,
		version: number,
	): Promise<AgentCatalogVersionDetail | null>;
	restoreVersion(
		agentId: string,
		version: number,
		userId?: string | null,
	): Promise<AgentDetail | null>;
	findAgentUsages(agentId: string): Promise<AgentCatalogUsage[]>;
	findAllAgentUsageCounts(): Promise<AgentCatalogUsageCounts>;
}

export interface AgentCompiledCapabilitiesRepository {
	compileAgentCapabilities(
		agentId: string,
	): Promise<AgentCompiledCapabilities | null>;
}

export interface AgentRegistryRepository {
	getRegistryStatus(
		agentId: string,
		input: { includeMetadata?: boolean },
	): Promise<AgentRegistryView | null>;
	registerAgent(agentId: string): Promise<AgentRegistrySyncResult>;
	deregisterAgent(agentId: string): Promise<AgentRegistrySyncResult>;
	syncAgentRuntime(agentId: string): Promise<void>;
}

export type DaprAgentRegistryStateReadResult = {
	found: boolean;
	value?: unknown;
	status?: number;
	error?: string;
};

export interface DaprAgentRegistryStateReader {
	getRegistryStoreName(): string;
	getRegistryTeams(): string[];
	readState(input: {
		store: string;
		key: string;
		team: string;
		partitionKey: string;
	}): Promise<DaprAgentRegistryStateReadResult>;
}

export interface AgentRuntimeCatalog {
	listRuntimeIds(): string[];
}

export interface AgentTemplateCatalog {
	resolveAgentTemplateConfig(slug: string | null): AgentConfig | null;
}

export type IngestSessionEventInput = AppendSessionEventInput & {
	sessionId: string;
};

export type IngestSessionEventResult = {
	event: SessionEventEnvelope;
	cleanupSessionSandbox: boolean;
};

export type WorkflowSessionEventNotification = {
	sessionId: string | null;
};

export type WorkflowSessionEventSubscription = {
	unlisten(): Promise<void>;
};

export interface WorkflowSessionEventNotificationSource {
	listenSessionEvents(
		onNotification: (notification: WorkflowSessionEventNotification) => void,
	): Promise<WorkflowSessionEventSubscription>;
}

export interface SandboxProvisioner {
	provision(input: SandboxProvisionInput): Promise<SandboxProvisionResult>;
}

export interface PreviewEnvironmentProvisioner {
	provision(input: ProvisionDevPreviewParams): Promise<DevPreviewInfo>;
}

export interface WorkflowDataService {
	getUserProfile(userId: string): Promise<UserProfileRecord | null>;
	isPlatformAdmin(userId: string): Promise<boolean>;
	canViewContaminationRiskMetadata(input: {
		userId: string;
		projectId?: string | null;
	}): Promise<boolean>;
	resolveWorkspaceProjectId(input: {
		slug?: string | null;
		userId: string;
		currentProjectId: string;
	}): Promise<string | null>;
	resolveSessionProjectId(input: {
		userId: string;
		currentProjectId: string;
	}): Promise<string | null>;
	getExecutionWorkspaceRoute(
		executionId: string,
	): Promise<ExecutionWorkspaceRouteInfo | null>;
	listWorkspaces(input: {
		userId: string;
		currentProjectId: string;
	}): Promise<WorkspaceSummary[]>;
	createWorkspace(input: {
		displayName: string;
		externalId?: string;
		userId: string;
		platformId: string;
	}): Promise<WorkspaceSummary>;
	renameWorkspace(input: {
		projectId: string;
		userId: string;
		displayName: string;
	}): Promise<boolean>;
	getWorkspaceProjectExternalId(projectId: string): Promise<string | null>;
	getWorkspaceProjectMembershipDetail(input: {
		projectId: string;
		userId: string;
	}): Promise<WorkspaceProjectMembershipDetail | null>;
	listProjectMembers(input: {
		projectId: string;
		userId: string;
	}): Promise<ProjectMembersResult>;
	addProjectMember(input: {
		projectId: string;
		userId: string;
		targetUserId?: unknown;
		email?: unknown;
		role?: unknown;
	}): Promise<ProjectMemberCommandResult>;
	updateProjectMemberRole(input: {
		projectId: string;
		memberId: string;
		userId: string;
		role?: unknown;
	}): Promise<ProjectMemberCommandResult>;
	deleteProjectMember(input: {
		projectId: string;
		memberId: string;
		userId: string;
	}): Promise<ProjectMemberDeleteResult>;
	getUsageAnalytics(input: {
		userId: string;
		projectId?: string | null;
		start?: string | null;
		end?: string | null;
		groupBy?: string | null;
		now?: Date;
	}): Promise<UsageAnalyticsReadModel>;
	getCostBreakdown(input: {
		userId: string;
		projectId?: string | null;
		start?: string | null;
		end?: string | null;
		now?: Date;
	}): Promise<CostBreakdownReadModel>;
	getLiveLimitSnapshot(input: {
		userId: string;
		projectId?: string | null;
		now?: Date;
	}): Promise<LiveLimitReadModel>;
	listEnabledModelIds(): Promise<string[]>;
	listSandboxExecutions(sandboxName: string): Promise<SandboxExecutionReadModel[]>;
	getSandboxStats(input?: { now?: Date }): Promise<SandboxStatsReadModel>;
	getWorkflowByRef(
		ref: WorkflowRef & { lookup?: "id" | "name" | "auto" },
	): Promise<WorkflowDefinition | null>;
	listActiveWorkflowExecutionsForUser(
		userId: string,
	): Promise<ActiveWorkflowExecutionReadModel[]>;
	listInternalAgentWorkflowExecutions(
		input: InternalAgentWorkflowExecutionListInput,
	): Promise<InternalAgentWorkflowExecutionListReadModel>;
	listWorkflows(input: {
		limit: number;
		projectId?: string | null;
	}): Promise<WorkflowDefinitionListItem[]>;
	listWorkspaceWorkflowSummaries(input: {
		limit: number;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkspaceWorkflowListItem[]>;
	listServiceGraphPickerOptions(input: {
		userId: string;
		projectId?: string | null;
		workflowLimit: number;
		executionLimit: number;
	}): Promise<ServiceGraphPickerOptions>;
	findProjectWorkflowIdByIdOrNamePrefix(input: {
		projectId: string;
		workflowId: string;
		namePrefix: string;
	}): Promise<string | null>;
	getPieceCatalogDetail(input: {
		pieceNameCandidates: string[];
		projectId: string;
	}): Promise<PieceCatalogDetail>;
	getPieceConnectionDetailPage(input: {
		pieceName: string;
		projectId: string;
	}): Promise<PieceConnectionDetailPageReadModel | null>;
	listConnectablePieces(input: {
		authOnly?: boolean;
	}): Promise<ConnectablePieceReadModel[]>;
	listCatalogFunctions(input: {
		userId?: string | null;
	}): Promise<CatalogFunctionsReadModel>;
	getSettingsPageReadModel(input: {
		userId: string;
		sessionPlatformId?: string | null;
	}): Promise<SettingsPageReadModel>;
	savePlatformOAuthApp(input: SavePlatformOAuthAppInput): Promise<{
		success: true;
		app?: PlatformOAuthAppMutationRecord | null;
	}>;
	deletePlatformOAuthApp(id: string): Promise<void>;
	listProjectMcpConnections(projectId: string): Promise<McpConnectionRecord[]>;
	createProjectMcpConnection(
		input: CreateProjectMcpConnectionInput,
	): Promise<McpConnectionCommandResult>;
	updateProjectMcpConnection(
		input: UpdateProjectMcpConnectionInput,
	): Promise<McpConnectionCommandResult>;
	deleteProjectMcpConnection(input: {
		id: string;
		projectId: string;
	}): Promise<McpConnectionDeleteResult>;
	discoverProjectMcpConnectionTools(input: {
		id: string;
		projectId: string;
	}): Promise<McpConnectionToolDiscoveryResult>;
	getMcpCatalogPieceActions(pieceName: string): Promise<McpCatalogPieceActionsResult>;
	getMcpConnectionCatalog(input: {
		projectId: string;
		platformId?: string | null;
		query?: string | null;
		authOnly?: boolean;
		configuredOnly?: boolean;
	}): Promise<McpConnectionCatalogReadModel>;
	getMcpAvailability(input: {
		projectId: string;
		platformId?: string | null;
	}): Promise<McpAvailabilityReadModel>;
	getProjectHostedMcpServer(input: {
		projectId: string;
		userId: string;
		requestUrl?: string | null;
	}): Promise<HostedMcpServerResult>;
	getInternalHostedMcpServer(input: {
		projectId?: string | null;
	}): Promise<InternalHostedMcpServerResult>;
	getInternalProjectMcpCatalog(input: {
		projectRef?: string | null;
	}): Promise<InternalProjectMcpCatalogResult>;
	updateProjectHostedMcpServerStatus(input: {
		projectId: string;
		userId: string;
		status?: unknown;
		requestUrl?: string | null;
	}): Promise<HostedMcpServerResult>;
	rotateProjectHostedMcpServerToken(input: {
		projectId: string;
		userId: string;
		requestUrl?: string | null;
	}): Promise<HostedMcpServerResult>;
	getMcpRun(runId: string): Promise<McpRunRecord | null>;
	respondToMcpRun(input: {
		runId: string;
		response: unknown;
	}): Promise<McpRunRecord | null>;
	startHostedMcpWorkflowTool(
		input: StartHostedMcpWorkflowToolInput,
	): Promise<StartHostedMcpWorkflowToolResult>;
	listProjectAppConnections(input: {
		projectId: string;
		pieceName?: string | null;
		provider?: string | null;
		search?: string | null;
		status?: string | null;
		type?: string | null;
		scope?: string | null;
	}): Promise<AppConnectionListItem[]>;
	createProjectAppConnection(
		input: AppConnectionCreateInput,
	): Promise<AppConnectionCreateResult>;
	updateProjectAppConnection(input: {
		id: string;
		projectId: string;
		displayName?: unknown;
	}): Promise<AppConnectionUpdateResult>;
	deleteProjectAppConnection(input: {
		id: string;
		projectId: string;
	}): Promise<AppConnectionDeleteResult>;
	getAdminPiecesReadModel(): Promise<AdminPiecesReadModel>;
	setAdminPieceEnabled(input: {
		pieceName: string;
		enabled: boolean;
		disabledBy?: string | null;
	}): Promise<void>;
	getBenchmarkBrowserReadModel(input: {
		projectId: string | null;
	}): Promise<BenchmarkBrowserReadModel>;
	getBenchmarkRunsPageReadModel(input: {
		projectId: string;
	}): Promise<BenchmarkRunsPageReadModel>;
	getBenchmarkComparePageReadModel(input: {
		projectId: string;
		runsParam?: string | null;
		tag?: string | null;
	}): Promise<BenchmarkComparePageReadModel>;
	getObservabilityServiceGraphContext(input: {
		userId: string;
		projectId?: string | null;
		executionId?: string | null;
		workflowId?: string | null;
	}): Promise<ObservabilityServiceGraphContextReadModel | null>;
	resolveWorkflowActivityRateTarget(input: {
		executionId: string;
	}): Promise<WorkflowActivityRateTargetReadModel | null>;
	getObservabilityTraceScope(input: {
		userId: string;
		projectId?: string | null;
		sessionIdFilter?: string | null;
		sessionLimit?: number;
		executionLimit?: number;
	}): Promise<ObservabilityTraceScopeReadModel | null>;
	listObservabilityTraceGoalChips(input: {
		sessionIds: string[];
	}): Promise<ObservabilityTraceGoalChipReadModel[]>;
	listWorkflowMonitorFallbackExecutions(input: {
		limit: number;
	}): Promise<WorkflowMonitorFallbackExecutionReadModel[]>;
	getPromptPresetUsages(input: {
		presetId: string;
		projectId: string;
	}): Promise<PromptPresetUsagesReadModel | null>;
	listAgentSkillUsedBy(input: {
		skillRef: string;
		projectId?: string | null;
		limit: number;
	}): Promise<AgentSkillUsedByReadModel | null>;
	getVaultUsages(input: {
		vaultId: string;
	}): Promise<VaultUsagesReadModel>;
	listAiAssistantMessages(input: {
		workflowId: string;
		userId: string;
		limit: number;
	}): Promise<WorkflowAiAssistantMessageReadModel[]>;
	deleteAiAssistantMessages(input: {
		workflowId: string;
		userId: string;
	}): Promise<void>;
	getSecurityAudit(input: {
		projectId?: string | null;
		now?: Date;
	}): Promise<SecurityAuditReadModel>;
	getDashboard(input: {
		userId: string;
		now?: Date;
	}): Promise<DashboardReadModel>;
	getHomePageReadModel(input: {
		userId: string;
		projectId?: string | null;
		limit?: number;
	}): Promise<HomePageReadModel>;
	getBenchmarkInstanceDetail(input: {
		suiteSlug: string;
		instanceId: string;
	}): Promise<BenchmarkInstanceDetailReadModel | null>;
	listBenchmarkRunInstanceScores(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}): Promise<BenchmarkRunInstanceScoresReadModel>;
	getBenchmarkRunInstanceDetail(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}): Promise<BenchmarkRunInstanceDetailReadModel>;
	getBenchmarkRunInstanceAnnotations(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}): Promise<BenchmarkRunInstanceAnnotationsReadModel>;
	upsertBenchmarkRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
		verdict?: unknown;
		reasoning?: unknown;
	}): Promise<
		| BenchmarkRunInstanceAnnotationCommandResult
		| { status: "invalid_verdict"; allowed: BenchmarkInstanceAnnotationVerdict[] }
	>;
	deleteBenchmarkRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}): Promise<BenchmarkRunInstanceAnnotationCommandResult>;
	promoteBenchmarkRunInstanceToDataset(input: {
		projectId: string;
		datasetId: string;
		runId?: unknown;
		instanceId?: unknown;
		now?: Date;
	}): Promise<
		| PromoteBenchmarkRunInstanceToDatasetResult
		| { status: "invalid_input"; message: string }
	>;
	getBenchmarkRunInstanceProgress(input: {
		runId: string;
		instanceId: string;
		now?: Date;
	}): Promise<BenchmarkRunInstanceProgressReadModel>;
	ingestBenchmarkEvaluationResults(
		input: BenchmarkEvaluationResultsCallbackInput,
	): Promise<BenchmarkEvaluationIngestResult>;
	recordBenchmarkArtifact(input: BenchmarkArtifactMetadataInput): Promise<void>;
	getBenchmarkRunProjectId(runId: string): Promise<string | null>;
	getDevPreviewHubReadModel(input: {
		projectId?: string | null;
	}): Promise<DevPreviewHubReadModel>;
	listDevPreviewServices(): Promise<DevPreviewServiceReadModel[]>;
	listDevEnvironments(input: {
		projectId?: string | null;
	}): Promise<DevEnvironmentSummaryReadModel[]>;
	getDevEnvironmentOrPending(input: {
		executionId: string;
		projectId?: string | null;
	}): Promise<DevEnvironmentSummaryReadModel | null>;
	resolveCanonicalExecutionId(input: { executionId: string }): Promise<string>;
	createWorkflowDefinition(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition>;
	updateWorkflowDefinition(
		id: string,
		input: UpdateWorkflowDefinitionInput,
	): Promise<WorkflowDefinition | null>;
	hasActiveWorkflowExecutions(id: string): Promise<boolean>;
	deleteWorkflowDefinition(id: string): Promise<void>;
	listWorkflowTriggers(workflowId: string): Promise<WorkflowTriggerRecord[]>;
	createWorkflowTrigger(input: CreateWorkflowTriggerInput): Promise<WorkflowTriggerRecord>;
	getWorkflowTrigger(input: {
		workflowId: string;
		triggerId: string;
	}): Promise<WorkflowTriggerRecord | null>;
	getWorkflowTriggerById(triggerId: string): Promise<WorkflowTriggerRecord | null>;
	markWorkflowTriggerFired(input: { triggerId: string; firedAt?: Date }): Promise<void>;
	deleteWorkflowTrigger(triggerId: string): Promise<void>;
	getPieceExecutionByIdempotencyKey(
		idempotencyKey: string,
	): Promise<PieceExecutionReadModel | null>;
	getSessionProvisioningReadModel(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionProvisioningResult>;
	getSessionContextUsage(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionContextUsageReadModel | null>;
	getSessionBrowserTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserTarget | null>;
	getSessionRuntimeConfig(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<RuntimeConfigCloudEvent | null>;
	getSessionRuntimeDebugTarget(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionRuntimeDebugTarget | null>;
	getSessionRuntimeCompute(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionRuntimeComputeReadModel | null>;
	getSessionRuntimeFlags(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionRuntimeFlagsReadModel | null>;
	getNewSessionPageReadModel(): Promise<NewSessionPageReadModel>;
	getSessionControlSettings(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionControlSettingsReadModel | null>;
	saveWorkflowBrowserArtifact(
		input: SaveWorkflowBrowserArtifactInput,
	): Promise<WorkflowBrowserArtifactRecord>;
	listWorkflowBrowserArtifactsByExecutionId(
		workflowExecutionId: string,
	): Promise<WorkflowBrowserArtifactRecord[]>;
	getWorkflowBrowserBlobPayload(storageRef: string): Promise<WorkflowBrowserBlobPayload | null>;
	validateApiKeyForUser(input: {
		authorizationHeader: string | null;
		userId: string;
	}): Promise<ApiKeyValidationResult>;
	listUserApiKeys(userId: string): Promise<UserApiKeyListItem[]>;
	createUserApiKey(input: {
		userId: string;
		name: string;
	}): Promise<UserApiKeyWithPlaintext>;
	deleteUserApiKey(input: { userId: string; keyId: string }): Promise<boolean>;
	rotateUserApiKey(input: {
		userId: string;
		keyId: string;
	}): Promise<UserApiKeyWithPlaintext | null>;
	assertExecutionReadModelReady(): Promise<void>;
	getExecutionById(id: string): Promise<WorkflowExecutionRecord | null>;
	getScopedExecutionById(
		input: WorkflowExecutionScopeInput,
	): Promise<WorkflowExecutionRecord | null>;
	getExecutionByDaprInstanceId(
		instanceId: string,
	): Promise<WorkflowExecutionRecord | null>;
	getWorkflowExecutionSessionOwnerContext(
		executionId: string,
	): Promise<WorkflowExecutionSessionOwnerContext | null>;
	getRunningWorkflowExecution(workflowId: string): Promise<{ id: string; status: string } | null>;
	listCliWorkspaceCommandCandidates(input: {
		executionId: string;
		limit: number;
	}): Promise<CliWorkspaceCommandCandidate[]>;
	getWorkflowEnsureSession(
		sessionId: string,
	): Promise<WorkflowEnsureSessionRecord | null>;
	createWorkflowEnsureSession(input: CreateWorkflowEnsureSessionInput): Promise<void>;
	updateWorkflowEnsureSessionRuntime(
		input: UpdateWorkflowEnsureSessionRuntimeInput,
	): Promise<void>;
	listTerminalWorkflowSessionRuntimeHosts(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowSessionRuntimeHostRecord[]>;
	checkBenchmarkSessionProvisioningGate(input: {
		runId: string;
		instanceId?: string | null;
	}): Promise<BenchmarkSessionProvisioningGateResult>;
	ensurePeerSession(input: EnsurePeerSessionInput): Promise<EnsurePeerSessionResult>;
	resolvePeerAgentDispatchContext(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<PeerAgentDispatchContext | null>;
	getWorkflowAgentRuntimeIdentity(
		agentId: string,
	): Promise<WorkflowAgentRuntimeIdentity | null>;
	resolvePublishedWorkflowAgentForEnsure(input: {
		agentId: string | null;
		agentVersion?: number | null;
		projectId?: string | null;
	}): Promise<WorkflowPublishedAgentResolutionResult | null>;
	countActiveTriggeredWorkflowRuns(input: {
		statuses: WorkflowExecutionStatus[];
	}): Promise<number>;
	getExecutionLineage(executionId: string): Promise<WorkflowExecutionLineage | null>;
	listWorkflowExecutions(input: {
		workflowId: string;
		limit: number;
		include?: "summary" | "full";
	}): Promise<WorkflowExecutionListItem[]>;
	listWorkflowExecutionRunSummaries(input: {
		workflowId: string;
		limit: number;
	}): Promise<WorkflowExecutionRunSummary[]>;
	listExecutionSessions(input: {
		executionId: string;
		projectId?: string | null;
		includeAncestors?: boolean;
	}): Promise<WorkflowExecutionSessionSummary[]>;
	listExecutionOutputFiles(
		executionId: string,
	): Promise<WorkflowExecutionOutputFiles>;
	aggregateExecutionUsageMetrics(input: {
		executionId: string;
		projectId?: string | null;
		includeAncestors?: boolean;
	}): Promise<WorkflowExecutionUsageMetricsRow[]>;
	createWorkflowExecution(
		input: CreateWorkflowExecutionInput,
	): Promise<{ id: string }>;
	getLiveExecutionInstance(
		executionId: string,
	): Promise<{ instanceId: string; status: string } | null>;
	attachExecutionSchedulerInstance(input: {
		executionId: string;
		instanceId: string;
		workflowSessionId?: string | null;
		primaryTraceId?: string | null;
	}): Promise<void>;
	markExecutionStartFailed(input: { executionId: string; error: string }): Promise<void>;
	listStaleRunningExecutions(input: {
		olderThanMinutes: number;
	}): Promise<Pick<WorkflowExecutionRecord, "id" | "daprInstanceId" | "input">[]>;
	updateExecutionReadModel(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	): Promise<void>;
	appendExecutionLog(
		input: AppendWorkflowExecutionLogInput,
	): Promise<WorkflowExecutionLogRecord>;
	updateExecutionLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	): Promise<WorkflowExecutionLogRecord | null>;
	listExecutionLogs(executionId: string): Promise<WorkflowExecutionLogRecord[]>;
	listExecutionSessionIds(executionId: string): Promise<string[]>;
	listExecutionAgentEvents(
		executionId: string,
	): Promise<WorkflowExecutionAgentEventRecord[]>;
	listExecutionAgentEventsAfter(input: {
		executionId: string;
		afterEventId: number;
	}): Promise<WorkflowExecutionAgentEventRecord[]>;
	getSessionEventStreamSnapshot(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionDetail | null>;
	getSessionDetail(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionDetail | null>;
	getSessionGoalFlow(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
		agentDecisions?: ObservabilityAgentDecisionTurn[];
	}): Promise<{ status: "ok"; goalFlow: GoalFlow | null } | { status: "not_found" }>;
	listSessionResources(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionResource[] | null>;
	addSessionResource(input: {
		sessionId: string;
		resource: AddSessionResourceInput;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<AddSessionResourceResult>;
	removeSessionResource(input: {
		sessionId: string;
		resourceId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<boolean>;
	updateSessionTitle(input: {
		sessionId: string;
		title: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionDetail | null>;
	archiveSession(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<boolean>;
	deleteSession(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<boolean>;
	raiseSessionAgentConfigPatch(input: {
		sessionId: string;
		patch: unknown;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionAgentConfigPatchResult>;
	listSessionEvents(
		sessionId: string,
		input?: ListSessionEventsInput,
	): Promise<SessionEventEnvelope[]>;
	listenSessionEventNotifications(
		onNotification: (notification: WorkflowSessionEventNotification) => void,
	): Promise<WorkflowSessionEventSubscription>;
	findSessionIdByDaprInstanceId(instanceId: string): Promise<string | null>;
	resolveSessionIdForProvisioningEvent(input: {
		runtimeAppId?: string | null;
		sessionId?: string | null;
	}): Promise<string | null>;
	getSessionFileOwner(
		sessionId: string,
	): Promise<{ id: string; userId: string; projectId: string | null } | null>;
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope>;
	getSessionEvent(input: {
		sessionId: string;
		eventId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionEventEnvelope | null>;
	appendSessionUserEvents(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
		events: UserEvent[];
	}): Promise<
		| {
				status: "ok";
				events: SessionEventEnvelope[];
		  }
		| { status: "not_found" }
	>;
	ingestSessionEvent(input: IngestSessionEventInput): Promise<IngestSessionEventResult>;
	forkSessionFromEvent(input: {
		sourceSessionId: string;
		fromSequence: number;
		title?: string | null;
		agentConfig?: AgentConfig | null;
		userId: string;
		projectId?: string | null;
	}): Promise<
		| {
				status: "created";
				sessionId: string;
				sourceSessionId: string;
				replayed: number;
		  }
		| { status: "not_found" }
		| { status: "bad_request"; message: string }
	>;
	upsertWorkflowArtifact(input: WorkflowArtifactInput): Promise<{ id: string }>;
	listWorkflowArtifactsByExecutionId(
		executionId: string,
	): Promise<WorkflowArtifactRecord[]>;
	listSourceBundleArtifactsByWorkflowId(
		workflowId: string,
	): Promise<WorkflowArtifactRecord[]>;
	getWorkflowArtifactForExecution(input: {
		executionId: string;
		artifactId: string;
	}): Promise<WorkflowArtifactRecord | null>;
	updateWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		metadata: Record<string, unknown> | null;
	}): Promise<WorkflowArtifactRecord | null>;
	createWorkflowFile(input: CreateWorkflowFileInput): Promise<{
		file: WorkflowFileRecord;
		deduplicated: boolean;
	}>;
	listWorkflowFiles(filter: ListWorkflowFilesFilter): Promise<WorkflowFileRecord[]>;
	getWorkflowFile(id: string): Promise<WorkflowFileRecord | null>;
	getWorkflowFileContent(
		id: string,
	): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
	archiveWorkflowFile(input: { id: string; userId: string }): Promise<boolean>;
	deleteWorkflowFile(input: { id: string; userId: string }): Promise<boolean>;
	persistRunDiffArtifact(input: PersistWorkflowRunDiffInput): Promise<{
		id: string;
		fileId: string | null;
		bytes: number;
		truncated: boolean;
	}>;
	persistSourceBundleArtifact(input: PersistWorkflowSourceBundleInput): Promise<{
		id: string;
		fileId: string;
		bytes: number;
	}>;
	upsertWorkflowWorkspaceSession(
		input: UpsertWorkspaceSessionInput,
	): Promise<{ workspaceRef: string }>;
	listWorkflowWorkspaceSessionsByExecutionId(input: {
		executionId: string;
		limit?: number;
	}): Promise<WorkflowWorkspaceSessionRecord[]>;
	markWorkflowWorkspaceSessionCleaned(input: {
		workspaceRef: string;
	}): Promise<boolean>;
	upsertScheduledAgentRun(
		input: UpsertWorkflowAgentRunScheduledInput,
	): Promise<{ id: string }>;
	updateAgentRunLifecycle(
		input: UpdateWorkflowAgentRunLifecycleInput,
	): Promise<{ id: string; status: WorkflowAgentRunStatus }>;
	upsertPlanArtifact(input: WorkflowPlanArtifactInput): Promise<{
		artifactRef: string;
		storageBackend: "workflow_plan_artifacts";
		artifactType: string;
		status: WorkflowPlanArtifactStatus;
	}>;
	listPlanArtifactsByExecutionId(
		executionId: string,
	): Promise<WorkflowPlanArtifactRecord[]>;
	updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: WorkflowPlanArtifactStatus;
		metadata?: Record<string, unknown> | null;
	}): Promise<{ artifactRef: string; status: WorkflowPlanArtifactStatus }>;
	getPlanArtifact(artifactRef: string): Promise<WorkflowPlanArtifactRecord | null>;
	getTraceTargetsForExecution(executionId: string): Promise<TraceLinkTarget[]>;
	upsertTraceLineageLinks(
		input: UpsertTraceLineageLinksInput,
	): Promise<{ recorded: number; sourceKeys: string[] }>;
	resolveMcpConfig(input: {
		workflowId?: string | null;
		projectId?: string | null;
		requestedServers?: unknown[];
		includeProjectConnections?: boolean;
	}): Promise<WorkflowMcpResolutionResult>;
}
