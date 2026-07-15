import type {
	WorkflowAgentRunMode,
	WorkflowAgentRunStatus,
} from "./agents";
import type {
	TraceLinkTarget,
} from "./observability";
import type {
	WorkflowExecutionSessionOwnerContext,
	WorkflowExecutionSessionSummary,
} from "./sessions";
import type {
	ListProjectWorkflowRunsInput,
	ProjectWorkflowRunSummary,
	WorkflowBrowserBlobPayload,
	WorkflowBrowserCaptureStepInput,
} from "./workflows";

export type ServiceGraphExecutionOption = {
	id: string;
	label: string;
	workflowId: string | null;
	workflowName: string;
	status: string;
	startedAt: string;
};

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

export type WorkflowBrowserArtifactStatus = "pending" | "completed" | "partial" | "failed";

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

export interface WorkflowBrowserArtifactStore {
	save(input: SaveWorkflowBrowserArtifactInput): Promise<WorkflowBrowserArtifactRecord>;
	listByExecutionId(workflowExecutionId: string): Promise<WorkflowBrowserArtifactRecord[]>;
	getBlobPayload(storageRef: string): Promise<WorkflowBrowserBlobPayload | null>;
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
	getExecutionWorkspaceKey(executionId: string): Promise<string>;
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
	listProjectRuns(
		input: ListProjectWorkflowRunsInput,
	): Promise<ProjectWorkflowRunSummary[]>;
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
	listLogsByWorkflowSince(input: {
		workflowId: string;
		since: Date;
		executionLimit: number;
	}): Promise<WorkflowExecutionLogRecord[]>;
	listSessionIdsByExecutionId(executionId: string): Promise<string[]>;
	countActiveTriggeredRuns(input: { statuses: WorkflowExecutionStatus[] }): Promise<number>;
	listAgentEventsByExecutionId(
		executionId: string,
	): Promise<WorkflowExecutionAgentEventRecord[]>;
	listRecentAgentEventsByExecutionId(input: {
		executionId: string;
		limit: number;
	}): Promise<WorkflowExecutionAgentEventRecord[]>;
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
		/** Atomic compare-and-set: update only while this top-level key is absent. */
		ifAbsentMetadataKey?: string;
	}): Promise<WorkflowArtifactRecord | null>;
	/** Atomically merges top-level JSON metadata without replacing concurrent keys. */
	mergeWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		patch: Record<string, unknown>;
		/** Atomic compare-and-set: merge only while this top-level key is absent. */
		ifAbsentMetadataKey?: string;
	}): Promise<WorkflowArtifactRecord | null>;
}

export type WorkflowExecutionAgentRunRecord = {
	id: string;
	workflowExecutionId: string;
	workflowId: string;
	nodeId: string;
	mode: WorkflowAgentRunMode;
	status: WorkflowAgentRunStatus;
	agentWorkflowId: string;
	daprInstanceId: string;
	parentExecutionId: string;
	workspaceRef: string | null;
	artifactRef: string | null;
	result: Record<string, unknown> | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
	completedAt: Date | null;
};

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

export type ExecutionWorkspaceRouteInfo = {
	projectId: string;
	userId: string;
	workspaceSlug: string;
};

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
	getForExecution(input: {
		executionId: string;
		checkpointId: string;
	}): Promise<WorkflowCodeCheckpointReadModel | null>;
}

export type WorkflowCodeCheckpointOperationResult = Record<string, unknown>;

export interface WorkflowCodeCheckpointWorkspacePort {
	diffCheckpoint(input: {
		checkpoint: WorkflowCodeCheckpointReadModel;
		path?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult>;
	restoreCheckpoint(input: {
		checkpoint: WorkflowCodeCheckpointReadModel;
		sandboxName: string;
		repoPath?: string | null;
	}): Promise<WorkflowCodeCheckpointOperationResult>;
}
