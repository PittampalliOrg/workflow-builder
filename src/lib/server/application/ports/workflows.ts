import type { RuntimeConfigCloudEvent } from "$lib/server/sessions/runtime-config";
import type { AgentConfig } from "$lib/types/agents";
import type {
	GoalFlow,
	ObservabilityAgentDecisionTurn,
} from "$lib/types/observability";
import type {
	SessionDetail,
	SessionEventEnvelope,
	SessionResource,
  SessionStatus,
	UserEvent,
} from "$lib/types/sessions";
import type {
	AgentSkillUsedByReadModel,
	PeerAgentDispatchContext,
	ProjectWorkflowRunAgent,
	UpdateWorkflowAgentRunLifecycleInput,
	UpsertWorkflowAgentRunScheduledInput,
	WorkflowAgentRunStatus,
	WorkflowAgentRuntimeIdentity,
	WorkflowPublishedAgentResolutionResult,
} from "./agents";
import type {
	BenchmarkArtifactMetadataInput,
	BenchmarkBrowserReadModel,
	BenchmarkComparePageReadModel,
	BenchmarkEvaluationIngestResult,
	BenchmarkEvaluationResultsCallbackInput,
	BenchmarkInstanceAnnotationVerdict,
	BenchmarkInstanceDetailReadModel,
	BenchmarkRunInstanceAnnotationCommandResult,
	BenchmarkRunInstanceAnnotationsReadModel,
	BenchmarkRunInstanceDetailReadModel,
	BenchmarkRunInstanceProgressReadModel,
	BenchmarkRunInstanceScoresReadModel,
	BenchmarkRunsPageReadModel,
	BenchmarkSessionProvisioningGateResult,
	PromoteBenchmarkRunInstanceToDatasetResult,
} from "./benchmarks";
import type {
	AppConnectionCreateInput,
	AppConnectionCreateResult,
	AppConnectionDeleteResult,
	AppConnectionListItem,
	AppConnectionUpdateResult,
	PieceConnectionDetailPageReadModel,
	PlatformOAuthAppMutationRecord,
	SavePlatformOAuthAppInput,
} from "./connections";
import type {
	ActiveWorkflowExecutionReadModel,
	AppendWorkflowExecutionLogInput,
	CompareAndSetWorkflowExecutionReadModelInput,
	CreateWorkflowExecutionInput,
	ExecutionCliPreviewResolveResult,
	ExecutionPreviewBackend,
	ExecutionWorkspaceRouteInfo,
	InternalAgentWorkflowExecutionListInput,
	InternalAgentWorkflowExecutionListReadModel,
	SaveWorkflowBrowserArtifactInput,
	UpsertTraceLineageLinksInput,
	WorkflowArtifactInput,
	WorkflowArtifactRecord,
	WorkflowBrowserArtifactRecord,
	WorkflowExecutionAgentEventRecord,
	WorkflowExecutionAgentRunRecord,
	WorkflowExecutionLineage,
	WorkflowExecutionListItem,
	WorkflowExecutionLogPatch,
	WorkflowExecutionLogRecord,
	WorkflowExecutionOutputFiles,
	WorkflowExecutionReadModelPatch,
	WorkflowExecutionRecord,
	WorkflowExecutionRunSummary,
	WorkflowExecutionScopeInput,
	WorkflowExecutionStatus,
	WorkflowExecutionUsageMetricsRow,
	WorkflowMonitorFallbackExecutionReadModel,
	WorkflowPlanArtifactInput,
	WorkflowPlanArtifactRecord,
	WorkflowPlanArtifactStatus,
} from "./executions";
import type {
	CreateProjectMcpConnectionInput,
	HostedMcpServerResult,
	InternalHostedMcpServerResult,
	InternalProjectMcpCatalogResult,
	McpAvailabilityReadModel,
	McpCatalogPieceActionsResult,
	McpConnectionCatalogReadModel,
	McpConnectionCommandResult,
	McpConnectionDeleteResult,
	McpConnectionRecord,
	McpConnectionToolDiscoveryResult,
	McpRunRecord,
	StartHostedMcpWorkflowToolInput,
	StartHostedMcpWorkflowToolResult,
	UpdateProjectMcpConnectionInput,
	WorkflowMcpResolutionResult,
} from "./mcp";
import type {
	ObservabilityServiceGraphContextReadModel,
	ObservabilityTraceScopeReadModel,
	TraceLinkTarget,
} from "./observability";
import type {
	AdminPieceRuntimeImageEnableResult,
	AdminPieceRuntimeImageReconcileResult,
	AdminPieceRuntimeImageRegistrationResult,
	AdminPieceRuntimeImageStatus,
	AdminPiecesReadModel,
	ConnectablePieceReadModel,
	PieceCatalogDetail,
	PieceExecutionReadModel,
} from "./pieces";
import type {
  ApiKeyResolutionResult,
	ApiKeyValidationResult,
	CostBreakdownReadModel,
	DashboardReadModel,
	HomePageReadModel,
	LiveLimitReadModel,
	ProjectMemberCommandResult,
	ProjectMemberDeleteResult,
	ProjectMembersResult,
	PromptPresetUsagesReadModel,
	SecurityAuditReadModel,
	UsageAnalyticsReadModel,
	UserApiKeyListItem,
	UserApiKeyWithPlaintext,
	UserProfileRecord,
	VaultUsagesReadModel,
	WorkspaceProjectMembershipDetail,
} from "./platform";
import type {
	SandboxExecutionReadModel,
	SandboxSessionOwnerRecord,
	SandboxStatsReadModel,
} from "./sandboxes";
import type {
	AddSessionResourceInput,
	AddSessionResourceResult,
	AppendSessionEventInput,
	AttachSessionRuntimeInput,
	CreateWorkflowEnsureSessionInput,
	EnsurePeerSessionInput,
	EnsurePeerSessionResult,
	IngestSessionEventInput,
	IngestSessionEventResult,
	ListSessionEventsInput,
	NewSessionPageReadModel,
	ObservabilityTraceGoalChipReadModel,
	SessionAgentConfigPatchResult,
	SessionAgentRef,
	SessionBrowserTarget,
	SessionCommandAgent,
	SessionContextUsageReadModel,
	SessionControlSettingsReadModel,
	SessionProvisioningResult,
	SessionRuntimeComputeReadModel,
	SessionRuntimeDebugTarget,
	SessionRuntimeFlagsReadModel,
	SessionRuntimeTarget,
	UpdateWorkflowEnsureSessionRuntimeInput,
	UpsertWorkspaceSessionInput,
	WorkflowEnsureSessionRecord,
	WorkflowExecutionSessionOwnerContext,
	WorkflowExecutionSessionSummary,
	WorkflowSessionEventNotification,
	WorkflowSessionEventSubscription,
	WorkflowSessionRuntimeHostRecord,
	WorkflowWorkspaceSessionRecord,
} from "./sessions";
import type {
	CatalogFunctionsReadModel,
	CliWorkspaceCommandCandidate,
	ServiceGraphPickerOptions,
	SettingsPageReadModel,
	WorkspaceSummary,
} from "./shared";

export type WorkflowRef = {
	workflowId?: string | null;
	workflowName?: string | null;
};

export type WorkflowVisibility = "private" | "public";

export type WorkflowEngineType = "vercel" | "dapr" | "dynamic-script";

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

export interface WorkflowMonitorReadRepository {
	listFallbackExecutions(input: {
		limit: number;
	}): Promise<WorkflowMonitorFallbackExecutionReadModel[]>;
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
  deleteMessages(input: { workflowId: string; userId: string }): Promise<void>;
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

export type UpdateWorkflowTriggerLifecycleStateInput = {
	triggerId: string;
	status: WorkflowTriggerStatus;
	backingRef?: string | null;
	lastError?: string | null;
	config?: Record<string, unknown>;
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
	updateLifecycleState(
		input: UpdateWorkflowTriggerLifecycleStateInput,
	): Promise<void>;
	delete(triggerId: string): Promise<void>;
}

export type WorkflowTriggerLifecycleActionResult =
	| { ok: true; status: string }
	| { ok: false; error: string };

export interface WorkflowTriggerLifecyclePort {
	activateTrigger(
		triggerId: string,
	): Promise<WorkflowTriggerLifecycleActionResult>;
	deactivateTrigger(
		triggerId: string,
	): Promise<WorkflowTriggerLifecycleActionResult>;
}

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

export type WorkflowBrowserBlobPayload = {
	payloadBase64: string;
	contentType: string;
};

export interface WorkflowDefinitionRepository {
	getById(id: string): Promise<WorkflowDefinition | null>;
	getLatestByName(name: string): Promise<WorkflowDefinition | null>;
  getLatestByNameInProject(
    name: string,
    projectId: string,
  ): Promise<WorkflowDefinition | null>;
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
	update(
		id: string,
		input: UpdateWorkflowDefinitionInput,
	): Promise<WorkflowDefinition | null>;
	hasActiveExecutions(id: string): Promise<boolean>;
	delete(id: string): Promise<void>;
}

export type ProjectWorkflowRunSummary = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: WorkflowExecutionStatus;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	sessionCount: number;
	agents: ProjectWorkflowRunAgent[];
};

export type ListProjectWorkflowRunsInput = {
	projectId: string;
	workflowId?: string;
	status?: WorkflowExecutionStatus;
	since?: Date;
	q?: string;
	limit?: number;
	offset?: number;
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

/** List files whose scopeId starts with a prefix (e.g. `preview-archive:`),
 * so the archived-previews browser can enumerate every archive scope in one
 * query. `scopeId` here is an exact match; this is the prefix counterpart. */
export type ListWorkflowFilesByScopePrefixFilter = {
	userId: string;
	scopeIdPrefix: string;
	purpose?: "agent" | "output";
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
		manifestVersion?: number | null;
		captureId?: string | null;
		capturedAt?: string | null;
		serviceCount?: number | null;
		services?: string[] | null;
		captureProtocol?: string | null;
		acceptanceEligible?: boolean | null;
		generation?: string | null;
		overlayDigests?: Record<string, string> | null;
		catalogDigest?: string | null;
		sourceRevision?: string | null;
		platformRevision?: string | null;
	};
};

export interface WorkflowFileStore {
	createFile(input: CreateWorkflowFileInput): Promise<{
		file: WorkflowFileRecord;
		deduplicated: boolean;
	}>;
	listFiles(filter: ListWorkflowFilesFilter): Promise<WorkflowFileRecord[]>;
	listFilesByScopePrefix(
		filter: ListWorkflowFilesByScopePrefixFilter,
	): Promise<WorkflowFileRecord[]>;
	getFile(id: string): Promise<WorkflowFileRecord | null>;
	getFileContent(
		id: string,
	): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
	archiveFile(input: { id: string; userId: string }): Promise<boolean>;
	deleteFile(input: { id: string; userId: string }): Promise<boolean>;
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

/**
 * Start request for a dynamic-script (engineType `dynamic-script`) workflow. The
 * adapter computes `scriptSha256` (node:crypto) and fills the `defaults`/`limits`
 * blocks (env-driven), so callers only supply the script + run context. Mirrors
 * `WorkflowStartRequest` for the SW path.
 */
export type WorkflowScriptStartRequest = {
	orchestratorUrl: string;
	headers: HeadersInit;
	script: string;
	meta: Record<string, unknown>;
	/** The script's verbatim input — any JSON value; undefined = not provided
	 *  (JSON.stringify drops the key, so the orchestrator omits `args` and the
	 *  script's `args` global is undefined). */
	args?: unknown;
	budgetTotal?: number | null;
	defaults?: Record<string, unknown>;
	dispatchMode?: string;
	/** Resume-after-edit: the orchestrator imports this execution's `done` rows. */
	journalImportFromExecutionId?: string;
	dbExecutionId: string;
	workflowId: string;
	userId: string;
	projectId: string | null;
	traceContext?: Record<string, string | undefined>;
};

export interface WorkflowScheduler {
	startSwWorkflow(
		input: WorkflowStartRequest,
	): Promise<{ instanceId?: string }>;
	startScriptWorkflow(
		input: WorkflowScriptStartRequest,
	): Promise<{ instanceId?: string }>;
}

export type WorkflowApprovalEventInput = {
	instanceId: string;
	eventType: string;
	approvedBy: string;
};

export type WorkflowApprovalEventResult =
	| { ok: true }
	| { ok: false; status: number; detail: string };

/** Generic external-event raise into a running workflow instance. */
export type WorkflowRaiseEventInput = {
	instanceId: string;
	eventName: string;
	eventData: Record<string, unknown>;
};

export interface WorkflowApprovalEventPort {
	raiseApprovalEvent(
		input: WorkflowApprovalEventInput,
	): Promise<WorkflowApprovalEventResult>;
	/**
	 * Raise an arbitrary external event (name + data) into a running workflow
	 * instance. Used by the dynamic-script skip control (`script.call.control`).
	 */
	raiseWorkflowEvent(
		input: WorkflowRaiseEventInput,
	): Promise<WorkflowApprovalEventResult>;
}

export type WorkflowRunStartInput = {
	workflowId?: string;
	workflowName?: string;
	userId?: string;
	/** Run input. SW 1.0 requires an object (trigger fields; non-objects are
	 *  coerced to {}); dynamic-script accepts ANY JSON value verbatim, with
	 *  undefined meaning "not provided" (the script's `args` global is
	 *  undefined). */
	triggerData?: unknown;
	executionId?: string;
	idempotent?: boolean;
	resumeFromNode?: string;
	seedWorkspaceFrom?: string;
	rerunOfExecutionId?: string;
	rerunSourceInstanceId?: string;
	triggerSource?: string;
	/** Dynamic-script resume-after-edit: import this source run's `done` journal. */
	journalImportFromExecutionId?: string;
	/** Dynamic-script token budget for the run. */
	budgetTotal?: number | null;
	/** Presentation surface that supplied environment-bound launch context. */
	launchSurface?: string;
	/** Origin candidate supplied by a presentation adapter for policy validation. */
	launchOrigin?: string | null;
	/** Fail closed if the resolved executable spec is not this exact digest. */
	expectedWorkflowSpecDigest?: `sha256:${string}`;
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
	startWorkflowRun(
		input: WorkflowRunStartInput,
	): Promise<WorkflowRunStartResult>;
}

export type WorkflowLaunchPolicyResult =
	| { ok: true; triggerData: unknown }
	| { ok: false; status: number; error: string };

export interface WorkflowLaunchPolicyPort {
	prepare(input: {
		workflow: Pick<WorkflowDefinition, "name" | "spec">;
		triggerData: unknown;
		launchSurface?: string;
		launchOrigin?: string | null;
	}): WorkflowLaunchPolicyResult;
}

export interface WorkflowSpecValidatorPort {
	isServerlessWorkflow(spec: unknown): boolean;
}

export type CliPreviewTarget = { podIP: string; runtime?: string | null };

export type CliPreviewResolveResult =
	| { ok: true; target: CliPreviewTarget }
	| { ok: false; status: number; message: string };

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
	executionPreviewBackend(
		executionId: string,
	): Promise<ExecutionPreviewBackend>;
}

export type DevPreviewServiceReadModel = {
	service: string;
	primaryCluster: string;
	previewTier: string;
	needsDapr: boolean;
	port: number;
	syncMode: string;
	repoUrl: string;
	repoSubdir: string;
	tailnetHost: string | null;
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
	/** Canonical launch order from the execution input, including services still pending persistence. */
	requestedServices?: string[];
};

export type DevPreviewHubReadModel = {
	services: DevPreviewServiceReadModel[];
	devWorkflowId: string | null;
	devWorkflowName: string;
	lifecycleWorkflowId: string | null;
	lifecycleWorkflowName: string;
};

/**
 * B5: one dev ENVIRONMENT = one execution with N per-service previews. A
 * multi-service session persists one `workflow_workspace_sessions` row per
 * service; this additive read model groups them so the Dev hub renders one
 * card per execution instead of one card per (execution, service).
 */
export type DevEnvironmentGroupReadModel = {
	executionId: string;
	/** All per-service rows for the execution, ordered by service name. */
	services: DevEnvironmentSummaryReadModel[];
	/** The first (newest) row — back-compat anchor for single-service UI paths. */
	primary: DevEnvironmentSummaryReadModel;
	/** True when EVERY service preview reports ready. */
	ready: boolean;
	sessionId: string | null;
	sessionUrl: string | null;
	runStatus: string | null;
	/** Earliest per-service createdAt (environment birth). */
	createdAt: string;
};

export interface DevEnvironmentReadRepository {
	listServices(): DevPreviewServiceReadModel[];
	listDevEnvironments(
		projectId: string | null | undefined,
	): Promise<DevEnvironmentSummaryReadModel[]>;
	/** B5 additive: `listDevEnvironments` rows grouped by execution. */
	listDevEnvironmentGroups(
		projectId: string | null | undefined,
	): Promise<DevEnvironmentGroupReadModel[]>;
	getDevEnvironmentOrPending(input: {
		executionId: string;
		projectId: string | null | undefined;
	}): Promise<DevEnvironmentSummaryReadModel | null>;
	/** Exact cleaned-row tombstone used only to resume idempotent teardown. */
	getDevEnvironmentTeardownTarget(input: {
		executionId: string;
		projectId: string | null | undefined;
	}): Promise<DevEnvironmentSummaryReadModel | null>;
  resolveCanonicalExecutionId(input: { executionId: string }): Promise<string>;
}

export type PreviewDatabaseProvisionResult = {
	databaseUrl: string;
	sourceUrl: string;
	dbName: string;
};

export interface PreviewDatabaseProvisioner {
	provision(input: {
		executionId: string;
	}): Promise<PreviewDatabaseProvisionResult>;
	drop(input: { executionId: string }): Promise<void>;
}

export type WorkflowDevSessionAgentPolicy = {
	slug: string;
	runtime: AgentConfig["runtime"];
	modelSpec: string;
	reasoningEffort?: string;
	contextWindowTokens?: number;
	runtimeIsolation?: AgentConfig["runtimeIsolation"];
};

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
	listSandboxExecutions(
		sandboxName: string,
	): Promise<SandboxExecutionReadModel[]>;
	listSandboxSessionOwners(input: {
		sandboxNames: string[];
	}): Promise<SandboxSessionOwnerRecord[]>;
	getSandboxStats(input?: { now?: Date }): Promise<SandboxStatsReadModel>;
	getWorkflowByRef(
		ref: WorkflowRef & { lookup?: "id" | "name" | "auto" },
	): Promise<WorkflowDefinition | null>;
  getScopedWorkflowByName(input: {
    workflowName: string;
    userId: string;
    projectId: string;
  }): Promise<WorkflowDefinition | null>;
	getScopedWorkflowById(input: {
		workflowId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkflowDefinition | null>;
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
	getMcpCatalogPieceActions(
		pieceName: string,
	): Promise<McpCatalogPieceActionsResult>;
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
	enableAdminPieceRuntimeImage(input: {
		pieceName: string;
		callbackUrl: string;
	}): Promise<AdminPieceRuntimeImageEnableResult>;
	recordAdminPieceRuntimeImageResult(input: {
		pieceName: string;
		version: string;
		status: AdminPieceRuntimeImageStatus;
		image?: string | null;
		digest?: string | null;
		errorMessage?: string | null;
	}): Promise<AdminPieceRuntimeImageRegistrationResult>;
	reconcileAdminPieceRuntimeImages(input?: {
		buildTimeoutMs?: number;
	}): Promise<AdminPieceRuntimeImageReconcileResult>;
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
	listObservabilityServiceGraphStepLogs(input: {
		userId: string;
		projectId?: string | null;
		executionId?: string | null;
		workflowId?: string | null;
		windowSeconds?: number;
		executionLimit?: number;
	}): Promise<WorkflowExecutionLogRecord[] | null>;
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
	getVaultUsages(input: { vaultId: string }): Promise<VaultUsagesReadModel>;
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
		| {
				status: "invalid_verdict";
				allowed: BenchmarkInstanceAnnotationVerdict[];
		  }
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
	listDevEnvironmentGroups(input: {
		projectId?: string | null;
	}): Promise<DevEnvironmentGroupReadModel[]>;
	getDevEnvironmentOrPending(input: {
		executionId: string;
		projectId?: string | null;
	}): Promise<DevEnvironmentSummaryReadModel | null>;
	getDevEnvironmentTeardownTarget(input: {
		executionId: string;
		projectId?: string | null;
	}): Promise<DevEnvironmentSummaryReadModel | null>;
  resolveCanonicalExecutionId(input: { executionId: string }): Promise<string>;
	createWorkflowDefinition(
		input: CreateWorkflowDefinitionInput,
	): Promise<WorkflowDefinition>;
	updateWorkflowDefinition(
		id: string,
		input: UpdateWorkflowDefinitionInput,
	): Promise<WorkflowDefinition | null>;
	hasActiveWorkflowExecutions(id: string): Promise<boolean>;
	deleteWorkflowDefinition(id: string): Promise<void>;
	listWorkflowTriggers(workflowId: string): Promise<WorkflowTriggerRecord[]>;
	createWorkflowTrigger(
		input: CreateWorkflowTriggerInput,
	): Promise<WorkflowTriggerRecord>;
	getWorkflowTrigger(input: {
		workflowId: string;
		triggerId: string;
	}): Promise<WorkflowTriggerRecord | null>;
	getWorkflowTriggerById(
		triggerId: string,
	): Promise<WorkflowTriggerRecord | null>;
	markWorkflowTriggerFired(input: {
		triggerId: string;
		firedAt?: Date;
	}): Promise<void>;
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
	getSessionOwnerUserId(sessionId: string): Promise<string | null>;
	attachSessionRuntime(input: AttachSessionRuntimeInput): Promise<void>;
	getSessionRuntimeTarget(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionRuntimeTarget | null>;
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
	getWorkflowBrowserBlobPayload(
		storageRef: string,
	): Promise<WorkflowBrowserBlobPayload | null>;
	validateApiKeyForUser(input: {
		authorizationHeader: string | null;
		userId: string;
    projectId?: string | null;
	}): Promise<ApiKeyValidationResult>;
  resolveApiKey(input: {
    authorizationHeader: string | null;
  }): Promise<ApiKeyResolutionResult>;
  listUserApiKeys(input: {
    userId: string;
    projectId: string;
  }): Promise<UserApiKeyListItem[]>;
	createUserApiKey(input: {
		userId: string;
    projectId: string;
		name: string;
  }): Promise<UserApiKeyWithPlaintext | null>;
	deleteUserApiKey(input: {
		userId: string;
    projectId: string;
		keyId: string;
	}): Promise<boolean>;
	rotateUserApiKey(input: {
		userId: string;
    projectId: string;
		keyId: string;
	}): Promise<UserApiKeyWithPlaintext | null>;
	assertExecutionReadModelReady(): Promise<void>;
	getExecutionById(id: string): Promise<WorkflowExecutionRecord | null>;
  getWorkflowExecutionOwner(executionId: string): Promise<{
    id: string;
    userId: string;
    projectId: string | null;
  } | null>;
	getScopedExecutionById(
		input: WorkflowExecutionScopeInput,
	): Promise<WorkflowExecutionRecord | null>;
	getExecutionByDaprInstanceId(
		instanceId: string,
	): Promise<WorkflowExecutionRecord | null>;
	getWorkflowExecutionWorkspaceKey(executionId: string): Promise<string>;
	getWorkflowExecutionSessionOwnerContext(
		executionId: string,
	): Promise<WorkflowExecutionSessionOwnerContext | null>;
	getRunningWorkflowExecution(
		workflowId: string,
	): Promise<{ id: string; status: string } | null>;
	listCliWorkspaceCommandCandidates(input: {
		executionId: string;
		limit: number;
	}): Promise<CliWorkspaceCommandCandidate[]>;
	hasInteractiveCliSessionForExecution(executionId: string): Promise<boolean>;
	getWorkflowEnsureSession(
		sessionId: string,
	): Promise<WorkflowEnsureSessionRecord | null>;
	createWorkflowEnsureSession(
		input: CreateWorkflowEnsureSessionInput,
	): Promise<void>;
	updateWorkflowEnsureSessionRuntime(
		input: UpdateWorkflowEnsureSessionRuntimeInput,
	): Promise<void>;
	listReapableWorkflowSessionRuntimeHosts(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowSessionRuntimeHostRecord[]>;
	checkBenchmarkSessionProvisioningGate(input: {
		runId: string;
		instanceId?: string | null;
	}): Promise<BenchmarkSessionProvisioningGateResult>;
	ensurePeerSession(
		input: EnsurePeerSessionInput,
	): Promise<EnsurePeerSessionResult>;
	resolvePeerAgentDispatchContext(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<PeerAgentDispatchContext | null>;
	resolveSessionAgent(input: {
		agentId: string;
		agentVersion?: number | null;
	}): Promise<SessionCommandAgent | null>;
	resolveSessionAgentByRef(
		ref: SessionAgentRef,
	): Promise<SessionCommandAgent | null>;
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
	getExecutionLineage(
		executionId: string,
	): Promise<WorkflowExecutionLineage | null>;
	listWorkflowExecutions(input: {
		workflowId: string;
		limit: number;
		include?: "summary" | "full";
	}): Promise<WorkflowExecutionListItem[]>;
	listWorkflowExecutionRunSummaries(input: {
		workflowId: string;
		limit: number;
	}): Promise<WorkflowExecutionRunSummary[]>;
	listProjectWorkflowRuns(
		input: ListProjectWorkflowRunsInput,
	): Promise<ProjectWorkflowRunSummary[]>;
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
	markExecutionStartFailed(input: {
		executionId: string;
		error: string;
	}): Promise<void>;
	listStaleRunningExecutions(input: {
		olderThanMinutes: number;
	}): Promise<
		Pick<WorkflowExecutionRecord, "id" | "daprInstanceId" | "input">[]
	>;
	updateExecutionReadModel(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	): Promise<void>;
	compareAndSetExecutionReadModel(
		input: CompareAndSetWorkflowExecutionReadModelInput,
	): Promise<WorkflowExecutionRecord | null>;
	appendExecutionLog(
		input: AppendWorkflowExecutionLogInput,
	): Promise<WorkflowExecutionLogRecord>;
	updateExecutionLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	): Promise<WorkflowExecutionLogRecord | null>;
  listExecutionLogs(executionId: string): Promise<WorkflowExecutionLogRecord[]>;
	listObservabilityServiceGraphStepLogs(input: {
		userId: string;
		projectId?: string | null;
		executionId?: string | null;
		workflowId?: string | null;
		windowSeconds?: number;
		executionLimit?: number;
	}): Promise<WorkflowExecutionLogRecord[] | null>;
	listExecutionSessionIds(executionId: string): Promise<string[]>;
	listExecutionAgentEvents(
		executionId: string,
	): Promise<WorkflowExecutionAgentEventRecord[]>;
	listRecentExecutionAgentEvents(input: {
		executionId: string;
		limit: number;
	}): Promise<WorkflowExecutionAgentEventRecord[]>;
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
	createWorkflowDevSession(input: {
		executionId: string;
		agentPolicy: WorkflowDevSessionAgentPolicy;
		instructions: string;
		title?: string | null;
	}): Promise<
		| {
				status: "created" | "reused";
				sessionId: string;
				agentSlug: string;
		  }
		| { status: "execution_not_found" }
		| { status: "agent_not_found"; agentSlug: string }
		| { status: "agent_policy_mismatch"; agentSlug: string }
		| {
				status: "session_conflict";
				reason: "ambiguous" | "identity_mismatch" | "instructions_mismatch";
		  }
	>;
	getSessionGoalFlow(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
		agentDecisions?: ObservabilityAgentDecisionTurn[];
	}): Promise<
		{ status: "ok"; goalFlow: GoalFlow | null } | { status: "not_found" }
	>;
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
  getSessionFileOwner(sessionId: string): Promise<{
    id: string;
    userId: string;
    projectId: string | null;
    status?: SessionStatus;
    completedAt?: Date | null;
  } | null>;
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope>;
	/** Agent Teams wake-on-deliver: atomic claim of unraised team-origin user
	 * events (the raise-side dedup) + rollback for failed raises. */
	claimUnraisedTeamEvents(
		sessionId: string,
	): Promise<
		Array<{ id: string; sequence: number; data: Record<string, unknown> }>
	>;
	unclaimSessionEvents(sessionId: string, ids: string[]): Promise<void>;
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
	ingestSessionEvent(
		input: IngestSessionEventInput,
	): Promise<IngestSessionEventResult>;
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
		ifAbsentMetadataKey?: string;
	}): Promise<WorkflowArtifactRecord | null>;
	mergeWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		patch: Record<string, unknown>;
		ifAbsentMetadataKey?: string;
	}): Promise<WorkflowArtifactRecord | null>;
	createWorkflowFile(input: CreateWorkflowFileInput): Promise<{
		file: WorkflowFileRecord;
		deduplicated: boolean;
	}>;
	listWorkflowFiles(
		filter: ListWorkflowFilesFilter,
	): Promise<WorkflowFileRecord[]>;
	listWorkflowFilesByScopePrefix(
		filter: ListWorkflowFilesByScopePrefixFilter,
	): Promise<WorkflowFileRecord[]>;
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
	persistSourceBundleArtifact(
		input: PersistWorkflowSourceBundleInput,
	): Promise<{
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
		order?: "asc" | "desc";
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
	listWorkflowAgentRunsByExecutionId(
		workflowExecutionId: string,
	): Promise<WorkflowExecutionAgentRunRecord[]>;
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
	getPlanArtifact(
		artifactRef: string,
	): Promise<WorkflowPlanArtifactRecord | null>;
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
