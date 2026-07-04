import type {
	AgentSkillConfig,
} from "$lib/agent-skill-presets";
import type {
	McpServerProfileConfig,
} from "$lib/server/agent-profiles";
import type {
	RuntimeConfigCloudEvent,
} from "$lib/server/sessions/runtime-config";
import type {
	AgentConfig,
	AgentToolChoice,
} from "$lib/types/agents";
import type {
	SessionDetail,
	SessionEventEnvelope,
	SessionResource,
	SessionResourceType,
	SessionStatus,
	SessionStopReason,
	SessionSummary,
	SessionUsage,
	UserEvent,
} from "$lib/types/sessions";
import type {
	SessionControlSettingsEnvironment,
} from "./benchmarks";
import type {
	SessionRuntimeCliAuthCredentialKind,
} from "./connections";
import type {
	SandboxSessionOwnerRecord,
} from "./sandboxes";

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

export type HomePageRecentSessionReadModel = {
	id: string;
	title: string | null;
	status: string;
	agentId: string;
	updatedAt: string;
};

export type HomePageRecentSessionRecord = {
	id: string;
	title: string | null;
	status: string;
	agentId: string;
	updatedAt: Date;
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

export type WorkflowExecutionSessionOwnerContext = {
	userId: string;
	workflowId: string;
	projectId: string | null;
};

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
	durableInstanceId: string | null;
	name: string;
	rootPath: string | null;
	clonePath: string | null;
	backend: WorkspaceSessionBackend;
	enabledTools: string[];
	requireReadBeforeWrite: boolean;
	commandTimeoutMs: number;
	status: WorkspaceSessionStatus;
	lastError: string | null;
	sandboxState: Record<string, unknown> | null;
	createdAt: Date;
	updatedAt: Date;
	lastAccessedAt: Date;
	cleanedAt: Date | null;
};

export interface WorkspaceSessionStore {
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
	getSessionOwnerUserId(input: { sessionId: string }): Promise<string | null>;
	attachSessionRuntime(input: AttachSessionRuntimeInput): Promise<void>;
	getSessionRuntimeTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionRuntimeTarget | null>;
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
	listWorkflowExecutionSessionRuntimes(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowExecutionSessionRuntimeRecord[]>;
	listSandboxSessionOwners(input: {
		sandboxNames: string[];
	}): Promise<SandboxSessionOwnerRecord[]>;
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
		session?: SessionDetail | null;
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

export type AttachSessionRuntimeInput = {
	sessionId: string;
	daprInstanceId?: string;
	natsSubject?: string;
	runtimeAppId?: string | null;
	runtimeSandboxName?: string | null;
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

export type WorkflowExecutionSessionRuntimeRecord = {
	sessionId: string;
	agentRuntime: string | null;
};

export type SessionRuntimeTargetSource = "persisted" | "agent" | "legacy";

export type SessionRuntimeTarget = {
	appId: string;
	invokeTarget: string;
	runtimeSandboxName: string | null;
	source: SessionRuntimeTargetSource;
};

export type SessionRuntimeDebugTarget = SessionRuntimeTarget & {
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

export type SessionControlSettingsAgent = {
	id: string;
	slug: string;
	version: number;
	config: AgentConfig;
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
	mountSessionRepositoriesViaHost(
		sessionId: string,
		hostBaseUrl: string,
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

export interface SessionCoordinatorOwnerPort {
	getSessionCoordinatorOwner(
		sessionId: string,
	): Promise<SessionCoordinatorOwner | null>;
}

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

export type GoalLoopEventMeta = { type: string; ageSeconds: number };

export type GoalLoopSessionStopState = {
	status: string;
	stopRequested: boolean;
};

export interface GoalLoopStore {
	getCurrentGoal(sessionId: string): Promise<SessionGoalRecord | null>;
	getDrivableGoal(sessionId: string): Promise<SessionGoalRecord | null>;
	accrueUsage(
		sessionId: string,
		deltaTokens: number,
	): Promise<SessionGoalRecord | null>;
	claimNextContinuation(
		sessionId: string,
		spacingSeconds?: number,
	): Promise<SessionGoalRecord | null>;
	claimIterationCap(sessionId: string): Promise<SessionGoalRecord | null>;
	claimBudgetSteer(sessionId: string): Promise<SessionGoalRecord | null>;
	markGoalComplete(sessionId: string): Promise<SessionGoalRecord | null>;
	pauseGoal(sessionId: string): Promise<SessionGoalRecord | null>;
	latestEventMeta(sessionId: string): Promise<GoalLoopEventMeta | null>;
	hasGoalCompletedEvent(sessionId: string): Promise<boolean>;
	sessionStopState(sessionId: string): Promise<GoalLoopSessionStopState | null>;
	getSessionWorkflowExecutionId(sessionId: string): Promise<string | null>;
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
	configHash?: string | null;
	projectId?: string | null;
	config: AgentConfig;
	environmentId?: string | null;
	environmentVersion?: number | null;
	defaultVaultIds?: string[];
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

export type SessionAgentRef = {
	id?: string;
	slug?: string;
	version?: number;
};

export interface SessionAgentSlugResolver {
	resolveSessionAgentIdBySlug(slug: string): Promise<string | null>;
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
