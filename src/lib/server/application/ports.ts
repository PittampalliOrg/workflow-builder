import type { AgentMcpResolutionResult } from "$lib/server/agents/mcp-resolution";
import type {
	SandboxProvisionInput,
	SandboxProvisionResult,
} from "$lib/server/sandboxes/provision";
import type {
	DevPreviewInfo,
	ProvisionDevPreviewParams,
} from "$lib/server/workflows/dev-preview";
import type { SessionDetail, SessionEventEnvelope } from "$lib/types/sessions";

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
	mlflowExperimentId: string | null;
	mlflowExperimentName: string | null;
	createdAt: Date;
	updatedAt: Date;
};

export interface WorkflowDefinitionRepository {
	getById(id: string): Promise<WorkflowDefinition | null>;
	getLatestByName(name: string): Promise<WorkflowDefinition | null>;
	getByRef(ref: WorkflowRef): Promise<WorkflowDefinition | null>;
}

export type WorkflowExecutionStatus = "pending" | "running" | "success" | "error" | "cancelled";

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
	getById(id: string): Promise<WorkflowExecutionRecord | null>;
	create(input: CreateWorkflowExecutionInput): Promise<{ id: string }>;
	attachSchedulerInstance(input: {
		executionId: string;
		instanceId: string;
		workflowSessionId?: string | null;
	}): Promise<void>;
	markStartFailed(input: { executionId: string; error: string }): Promise<void>;
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

export type WorkflowMcpResolutionResult = AgentMcpResolutionResult & {
	projectId: string | null;
};

export interface ArtifactStore {
	upsertWorkflowArtifact(input: WorkflowArtifactInput): Promise<{ id: string }>;
	listWorkflowArtifactsByExecutionId(executionId: string): Promise<WorkflowArtifactRecord[]>;
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

export interface WorkspaceSessionStore {
	upsertWorkflowWorkspaceSession(
		input: UpsertWorkspaceSessionInput,
	): Promise<{ workspaceRef: string }>;
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
	updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: WorkflowPlanArtifactStatus;
		metadata?: Record<string, unknown> | null;
	}): Promise<{ artifactRef: string; status: WorkflowPlanArtifactStatus }>;
	getPlanArtifact(artifactRef: string): Promise<WorkflowPlanArtifactRecord | null>;
}

export type MlflowRunTarget = {
	entityType: "workflow_execution" | "session";
	entityId: string;
	projectId: string | null;
	experimentId: string | null;
	runId: string;
};

export type UpsertMlflowTraceLineageLinksInput = {
	traceId: string;
	targets: MlflowRunTarget[];
	source?: string;
	attrs?: Record<string, string>;
};

export interface MlflowTraceLineageStore {
	getRunTargetsForExecution(executionId: string): Promise<MlflowRunTarget[]>;
	upsertTraceLineageLinks(
		input: UpsertMlflowTraceLineageLinksInput,
	): Promise<{ recorded: number; sourceKeys: string[] }>;
}

export type WorkflowStartRequest = {
	orchestratorUrl: string;
	workflow: Record<string, unknown>;
	workflowId: string;
	triggerData: Record<string, unknown>;
	dbExecutionId: string;
	headers: HeadersInit;
	mlflowContext?: unknown;
	traceContext?: Record<string, string | undefined>;
	resumeFromNode?: string;
	workspaceExecutionId?: string;
	seedWorkspaceFrom?: string;
};

export interface WorkflowScheduler {
	startSwWorkflow(input: WorkflowStartRequest): Promise<{ instanceId?: string }>;
}

export interface EventBus {
	publish(topic: string, payload: unknown): Promise<void>;
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

export interface SessionRepository {
	getSession(id: string): Promise<SessionDetail | null>;
}

export type AppendSessionEventInput = {
	type: string;
	data?: Record<string, unknown>;
	processedAt?: Date | null;
	sourceEventId?: string | null;
	producerId?: string | null;
	producerEpoch?: string | null;
};

export interface SessionEventLog {
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope>;
}

export interface SandboxProvisioner {
	provision(input: SandboxProvisionInput): Promise<SandboxProvisionResult>;
}

export interface PreviewEnvironmentProvisioner {
	provision(input: ProvisionDevPreviewParams): Promise<DevPreviewInfo>;
}

export interface WorkflowDataService {
	getWorkflowByRef(
		ref: WorkflowRef & { lookup?: "id" | "name" | "auto" },
	): Promise<WorkflowDefinition | null>;
	getExecutionById(id: string): Promise<WorkflowExecutionRecord | null>;
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
	upsertWorkflowArtifact(input: WorkflowArtifactInput): Promise<{ id: string }>;
	listWorkflowArtifactsByExecutionId(
		executionId: string,
	): Promise<WorkflowArtifactRecord[]>;
	upsertWorkflowWorkspaceSession(
		input: UpsertWorkspaceSessionInput,
	): Promise<{ workspaceRef: string }>;
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
	updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: WorkflowPlanArtifactStatus;
		metadata?: Record<string, unknown> | null;
	}): Promise<{ artifactRef: string; status: WorkflowPlanArtifactStatus }>;
	getPlanArtifact(artifactRef: string): Promise<WorkflowPlanArtifactRecord | null>;
	getMlflowRunTargetsForExecution(executionId: string): Promise<MlflowRunTarget[]>;
	upsertMlflowTraceLineageLinks(
		input: UpsertMlflowTraceLineageLinksInput,
	): Promise<{ recorded: number; sourceKeys: string[] }>;
	resolveMcpConfig(input: {
		workflowId?: string | null;
		projectId?: string | null;
		requestedServers?: unknown[];
		includeProjectConnections?: boolean;
	}): Promise<WorkflowMcpResolutionResult>;
}
