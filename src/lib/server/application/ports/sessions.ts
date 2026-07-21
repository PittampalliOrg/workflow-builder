import type { AgentSkillConfig } from "$lib/agent-skill-presets";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import type { RuntimeConfigCloudEvent } from "$lib/server/sessions/runtime-config";
import type { AgentConfig, AgentToolChoice } from "$lib/types/agents";
import type {
	PendingInput,
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
import type { SessionControlSettingsEnvironment } from "./benchmarks";
import type { SessionRuntimeCliAuthCredentialKind } from "./connections";
import type { SandboxSessionOwnerRecord } from "./sandboxes";

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
  getCurrentGoalForSessions(
    sessionIds: string[],
  ): Promise<GoalFlowGoalRecord | null>;
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
	offset?: number;
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

export type EnsureSessionRecordInput = CreateSessionRecordInput & {
	id: string;
};

export type EnsureSessionRecordResult = {
	session: SessionDetail;
	created: boolean;
};

export interface SessionRepository {
	listSessions(filter?: SessionListInput): Promise<SessionSummary[]>;
	getSession(id: string): Promise<SessionDetail | null>;
	createSession(input: CreateSessionRecordInput): Promise<SessionDetail>;
	/** Atomically inserts a caller-keyed session or returns the existing row. */
  ensureSession(
    input: EnsureSessionRecordInput,
  ): Promise<EnsureSessionRecordResult>;
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
	/**
	 * Non-archived sessions whose DB row is still non-terminal
	 * (running/idle/rescheduling/paused) and untouched for ≥ `minAgeSeconds` —
	 * the candidate set for the session liveness reconciler. Oldest-first,
	 * capped. Carries the benchmark/eval ownership flag (so the pure decider can
	 * skip coordinator-owned instances) plus everything the crash/auto-resume
	 * paths need without a second query.
	 */
	listLivenessReconcileCandidates(input: {
		minAgeSeconds: number;
		limit: number;
	}): Promise<LivenessReconcileCandidateRecord[]>;
	listWorkflowExecutionSessionRuntimes(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowExecutionSessionRuntimeRecord[]>;
	listSandboxSessionOwners(input: {
		sandboxNames: string[];
	}): Promise<SandboxSessionOwnerRecord[]>;
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
	createSessionFork(input: CreateSessionForkInput): Promise<{ id: string }>;
	getPeerSession(sessionId: string): Promise<PeerSessionRecord | null>;
	createPeerSession(input: CreatePeerSessionInput): Promise<PeerSessionRecord>;
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
  getSessionWorkflowContext(
		sessionId: string,
  ): Promise<SessionWorkflowContext | null>;
	updateSessionStatus(input: UpdateSessionStatusInput): Promise<void>;
	updateSessionStatusUnlessTerminated(
		input: UpdateSessionStatusUnlessTerminatedInput,
	): Promise<void>;
	/**
	 * Set status='rescheduling' with the same sticky-terminal guards as
	 * updateSessionStatusUnlessTerminated PLUS a running guard: a
	 * session.status_rescheduled event must never flip a row that is already
	 * `running` back to rescheduling. The runtime emits status_rescheduled at
	 * session entry ~250ms before status_running, and NATS ingestion can
	 * deliver them out of order — without this guard the row wedges at
	 * rescheduling for the whole session (the UI shows "Waiting for
	 * admission" forever even though the agent is working).
	 */
	updateSessionStatusRescheduled(
		input: UpdateSessionStatusUnlessTerminatedInput,
	): Promise<void>;
	/**
	 * Throttled liveness stamp: set `last_event_at = now()` at most once per 5s
	 * window. Fired on EVERY ingested event (including turn heartbeats) so the
	 * silence/liveness reconciler can distinguish a live-but-quiet session from
	 * a dead one WITHOUT scanning session_events. Must NOT touch `updated_at`.
	 */
	bumpSessionLastEventAt(sessionId: string): Promise<void>;
	/**
	 * Overwrite the `sessions.pending_input` needs-input cache (or clear it with
	 * `null`). Maintained by the single serialized ingest writer alongside the
	 * status writes so the session LIST + Fleet surfaces can badge a parked
	 * session without scanning session_events. Pure cache — must NOT touch
	 * `updated_at`. Session events remain the source of truth.
	 */
	setSessionPendingInput(
		sessionId: string,
		value: PendingInput | null,
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
	structuredOutputMode?: "tool" | null;
	responseJsonSchema?: Record<string, unknown> | null;
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

export type LivenessReconcileCandidateRecord = {
	id: string;
	status: string;
	agentId: string;
	agentVersion: number | null;
	agentSlug: string | null;
	/** agents.runtime → the reconciler resolves the runtime descriptor to gate on CLI family. */
	agentRuntime: string | null;
	userId: string;
	projectId: string | null;
	title: string | null;
	/** Interactive-cli resume lineage (auto-resume restart-budget walk). */
	resumedFromSessionId: string | null;
	/** null ⇒ never provisioned (no per-session runtime app-id yet). */
	runtimeAppId: string | null;
	/** Dapr instance id (falls back to session id) — the Dapr runtime-status probe key. */
	daprInstanceId: string | null;
	/** Per-session Sandbox CR name — the K8s CR-presence evidence key. */
	runtimeSandboxName: string | null;
	pauseRequestedAt: Date | null;
	stopRequestedAt: Date | null;
	/** true ⇒ a benchmark/eval coordinator owns this instance (skip; single stop authority). */
	coordinatorOwned: boolean;
	updatedAt: Date;
	/** Throttled liveness stamp (migration 0095); null ⇒ no event ever ingested. */
	lastEventAt: Date | null;
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
  parentExecutionId: string | null;
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
  getAgentWorkflowHostPod(
    appId: string,
  ): Promise<SessionRuntimePodTarget | null>;
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

/** Row shape returned by the team-event claim: enough to raise + unclaim. */
export type ClaimedSessionEventRecord = {
	id: string;
	sequence: number;
	data: Record<string, unknown>;
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
	/** Atomically claim unraised team-origin user events (processed_at stamp) —
	 * the raise-side dedup for the Agent Teams wake-on-deliver path. */
  claimUnraisedTeamEvents(
    sessionId: string,
  ): Promise<ClaimedSessionEventRecord[]>;
	/** Roll back a claim after a failed raise (JetStream will redeliver). */
	unclaimSessionEvents(sessionId: string, ids: string[]): Promise<void>;
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
	spawnSessionWorkflow(
		sessionId: string,
    options?: {
      persistentHost?: boolean;
      workflowMcpCapabilities?: {
        scriptDepth: number;
        teamId: string | null;
        teamRole: "none" | "lead" | "member";
      };
    },
	): Promise<{
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
  getCoordinatorOwner(
    sessionId: string,
  ): Promise<SessionCoordinatorOwner | null>;
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
  createOrReplaceGoal(
    input: CreateSessionGoalInput,
  ): Promise<SessionGoalRecord>;
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
