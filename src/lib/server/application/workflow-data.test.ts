import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  ApiKeyRecord,
	ApiKeyStore,
	AdminPieceRepository,
	AppConnectionRepository,
	ArtifactStore,
	BenchmarkArtifactMetadataRepository,
	BenchmarkDatasetPromotionRepository,
	BenchmarkEvaluationEventNotifier,
	BenchmarkEvaluationResultRepository,
	BenchmarkEvaluationTelemetryPort,
	BenchmarkRunInstanceAnnotationRepository,
	BenchmarkInstanceDetailReadRepository,
	BenchmarkBrowserRepository,
	BenchmarkRunInstanceDetailReadRepository,
	BenchmarkRunInstanceProgressReadRepository,
	BenchmarkRunInstanceScoreReadRepository,
	BenchmarkRunReadRepository,
	BenchmarkRunLifecyclePort,
	BenchmarkRunRepository,
	DevEnvironmentReadRepository,
	EvaluationArtifactStore,
	GoalFlowReadStore,
	HomePageReadRepository,
	HostedMcpServerRepository,
	McpConnectionRepository,
	McpConnectionRecord,
	McpRunRepository,
	PeerAgentResolver,
	RuntimeRegistryReader,
	ResourceUsageReadRepository,
	SettingsRepository,
	TraceLineageStore,
	UsageReportingRepository,
	SandboxInventoryRepository,
	SandboxRuntimeInventory,
	CodeFunctionCatalogRepository,
	DashboardReadRepository,
	SecurityAuditReadRepository,
	SessionAgentConfigCommandPort,
	SessionAgentResolver,
	SessionAgentSlugResolver,
	SessionEventLog,
	SessionExperimentAgentStore,
	SessionProvisioningReader,
	SessionRepository,
	SessionRuntimeConfigReader,
	SessionRuntimeEventRaiser,
	WorkflowDefinition,
	WorkflowBrowserArtifactStore,
	WorkflowDefinitionRepository,
	WorkflowFileStore,
	PieceExecutionRepository,
	WorkflowTriggerStore,
	WorkflowAgentRunStore,
	WorkflowAgentReadRepository,
	WorkflowCodeCheckpointStore,
	WorkflowExecutionRepository,
	WorkflowExecutionLogRecord,
	WorkflowExecutionRecord,
	PieceCatalogRepository,
	SessionRuntimeCliAuthReadModel,
	UserProfileRepository,
	WorkflowPlanArtifactStore,
	SessionRuntimeStatusReader,
	WorkflowSessionEventNotificationSource,
	WorkflowScheduler,
	WorkspaceProjectRepository,
	WorkspaceSessionStore,
	WorkflowActivityRateTargetRepository,
	WorkflowAiAssistantMessageRepository,
	ObservabilityTraceRepository,
	WorkflowMonitorReadRepository,
} from "$lib/server/application/ports";
import { ApplicationWorkflowDataService } from "$lib/server/application/workflow-data";
import type { RuntimeConfigCloudEvent } from "$lib/server/sessions/runtime-config";
import { createDefaultAgentConfig, type AgentConfig } from "$lib/types/agents";
import type { SessionDetail } from "$lib/types/sessions";

const dynamicPrivateEnv = vi.hoisted(
  () => ({}) as Record<string, string | undefined>,
);

vi.mock("$lib/server/security/encryption", () => ({
	encryptString: (plaintext: string) => ({
		iv: "test-iv",
		data: `encrypted:${plaintext}`,
	}),
	encryptObject: (value: Record<string, unknown>) => ({
		iv: "test-iv",
		data: `encrypted:${JSON.stringify(value)}`,
	}),
	decryptString: (value: { data: string }) =>
    value.data.startsWith("encrypted:")
      ? value.data.slice("encrypted:".length)
      : value.data,
	decryptObject: (value: { data: string }) =>
		JSON.parse(
      value.data.startsWith("encrypted:")
        ? value.data.slice("encrypted:".length)
        : value.data,
	),
}));

vi.mock("$env/dynamic/private", () => ({
	env: dynamicPrivateEnv,
}));

const baseWorkflow: WorkflowDefinition = {
	id: "wf-id",
	name: "example",
	description: null,
	userId: "user-1",
	projectId: "project-1",
	nodes: [],
	edges: [],
	specVersion: null,
	spec: null,
	visibility: "private",
	engineType: "dapr",
	daprWorkflowName: null,
	daprOrchestratorUrl: null,
	mlflowExperimentId: null,
	mlflowExperimentName: null,
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function fakeWorkflowTriggers(): WorkflowTriggerStore {
	return {
		listByWorkflowId: vi.fn(async () => []),
		create: vi.fn(async () => ({
			id: "trigger-1",
			workflowId: "wf-id",
			userId: "user-1",
			projectId: "project-1",
			kind: "webhook",
			config: {},
			triggerData: null,
			dedupSalt: "salt",
			backingRef: null,
			status: "inactive" as const,
			lastError: null,
			lastFiredAt: null,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		})),
		getById: vi.fn(async () => null),
		getForWorkflow: vi.fn(async () => null),
		markFired: vi.fn(async () => undefined),
		updateLifecycleState: vi.fn(async () => undefined),
		delete: vi.fn(async () => undefined),
	};
}

function workflowExecutionRecord(
	overrides: Partial<WorkflowExecutionRecord> = {},
): WorkflowExecutionRecord {
	return {
		id: "exec-1",
		workflowId: "wf-id",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
		input: null,
		output: { traceIds: ["trace-1"] },
		executionIrVersion: null,
		executionIr: null,
		error: null,
		daprInstanceId: "dapr-exec-1",
		phase: null,
		progress: null,
		currentNodeId: null,
		currentNodeName: null,
		primaryTraceId: "trace-primary",
		workflowSessionId: "session-1",
		mlflowExperimentId: null,
		mlflowRunId: null,
		summaryOutput: null,
		errorStackTrace: null,
		rerunOfExecutionId: null,
		rerunSourceInstanceId: null,
		resumeFromNode: null,
		triggerSource: null,
		rerunFromEventId: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		completedAt: null,
		duration: null,
		stopRequestedAt: null,
		stopReason: null,
		...overrides,
	};
}

function fakeApiKeys(): ApiKeyStore {
	return {
		getByKeyHash: vi.fn(async () => null),
		markUsed: vi.fn(async () => undefined),
    listVisibleInProject: vi.fn(async () => []),
    createProjectApiKey: vi.fn(async (input) => ({
			id: input.id,
			name: input.name,
			keyPrefix: input.keyPrefix,
      projectId: input.projectId,
      createdByUserId: input.createdByUserId,
      scopes: input.scopes,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			lastUsedAt: null,
		})),
    deleteForProject: vi.fn(async () => false),
    updateSecretForProject: vi.fn(async () => null),
	};
}

function fakeUserProfiles(): UserProfileRepository {
	return {
		getUserProfile: vi.fn(async () => null),
	};
}

function fakeHomePageReads(): HomePageReadRepository {
	return {
		listRecentHomeSessions: vi.fn(async () => []),
		listRecentHomeRuns: vi.fn(async () => []),
	};
}

function fakeSettings(): SettingsRepository {
	return {
		getSettingsUserProfile: vi.fn(async () => null),
		listPlatformOAuthApps: vi.fn(async () => []),
		listOAuthPieces: vi.fn(async () => []),
    resolvePlatformId: vi.fn(
      async (sessionPlatformId) => sessionPlatformId ?? "platform-1",
    ),
		savePlatformOAuthApp: vi.fn(async (input) => ({
			id: input.id ?? "oauth-app-1",
			platformId: input.platformId ?? "platform-1",
			pieceName: input.pieceName,
			clientId: input.clientId,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		})),
		deletePlatformOAuthApp: vi.fn(async () => undefined),
	};
}

function mcpConnection(
  overrides: Partial<McpConnectionRecord> = {},
): McpConnectionRecord {
	return {
		id: "mcp-1",
		projectId: "project-1",
		sourceType: "nimble_piece" as const,
		pieceName: "github",
		serverKey: null,
		connectionExternalId: null,
		displayName: "GitHub",
		registryRef: "ap-github-service",
		serverUrl: "http://ap-github-service/mcp",
		status: "ENABLED" as const,
		lastSyncAt: null,
		lastError: null,
		metadata: null,
		createdBy: "user-1",
		updatedBy: "user-1",
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		...overrides,
	};
}

function fakeMcpConnections(): McpConnectionRepository {
	return {
		listProjectConnections: vi.fn(async () => []),
		findProjectConnection: vi.fn(async () => null),
		findProjectNimblePieceConnection: vi.fn(async () => null),
		createProjectConnection: vi.fn(async (input) => mcpConnection(input)),
		updateProjectConnection: vi.fn(async (input) =>
			mcpConnection({
				id: input.id,
				projectId: input.projectId,
				status: input.status ?? "ENABLED",
				connectionExternalId: input.connectionExternalId ?? null,
				displayName: input.displayName ?? "GitHub",
				registryRef: input.registryRef ?? "ap-github-service",
				serverUrl: input.serverUrl ?? "http://ap-github-service/mcp",
				metadata: input.metadata ?? null,
				updatedBy: input.updatedBy,
			}),
		),
		deleteProjectConnection: vi.fn(async () => undefined),
		activeAppConnectionExistsForPiece: vi.fn(async () => true),
		listActiveAppConnectionCatalogSummaries: vi.fn(async () => []),
		listPlatformOAuthAppPieceNames: vi.fn(async () => []),
	};
}

function fakeHostedMcpServers(): HostedMcpServerRepository {
	const createdAt = new Date("2026-01-01T00:00:00.000Z");
	const updatedAt = new Date("2026-01-01T00:00:00.000Z");
	let server = {
		id: "mcp-server-1",
		projectId: "project-1",
		status: "DISABLED" as const,
		tokenEncrypted: { iv: "test-iv", data: "encrypted:hosted-token" },
		createdAt,
		updatedAt,
	};
	return {
		resolveProjectByIdOrExternalId: vi.fn(async () => ({
			id: "project-1",
			externalId: "workspace-1",
		})),
		getServerByProjectId: vi.fn(async () => server),
		createServer: vi.fn(async (input) => {
			server = { ...input, createdAt, updatedAt };
			return server;
		}),
		updateServerStatus: vi.fn(async (input) => {
			server = { ...server, status: input.status, updatedAt };
		}),
		updateServerToken: vi.fn(async (input) => {
			server = { ...server, tokenEncrypted: input.tokenEncrypted, updatedAt };
		}),
		getProjectOwnerId: vi.fn(async () => "owner-1"),
		listWorkflowSourcesForProject: vi.fn(async () => []),
		upsertHostedWorkflowConnection: vi.fn(async (input) =>
			mcpConnection({
				id: "hosted-mcp-connection",
				projectId: input.projectId,
				sourceType: "hosted_workflow",
				pieceName: null,
				serverKey: null,
				displayName: input.displayName ?? "Workflow Builder Hosted MCP",
				registryRef: input.registryRef ?? "mcp-gateway",
				serverUrl: input.serverUrl ?? null,
				status: input.status,
				metadata: input.metadata ?? null,
				createdBy: input.actorUserId ?? null,
				updatedBy: input.actorUserId ?? null,
			}),
		),
	};
}

function fakeMcpRuns(): McpRunRepository {
	const createdAt = new Date("2026-01-01T00:00:00.000Z");
	const updatedAt = new Date("2026-01-01T00:00:00.000Z");
	const run = {
		id: "mcp-run-1",
		projectId: "project-1",
		mcpServerId: "mcp-server-1",
		workflowId: "wf-id",
		workflowExecutionId: null,
		daprInstanceId: null,
		toolName: "generate_summary",
		input: { document: "hello" },
		response: null,
		status: "STARTED" as const,
		respondedAt: null,
		createdAt,
		updatedAt,
	};
	return {
		createRun: vi.fn(async (input) => ({
			...run,
			...input,
		})),
		attachExecution: vi.fn(async () => undefined),
		getRun: vi.fn(async () => run),
		respondToRun: vi.fn(async (input) => ({
			...run,
			response: input.response,
			status: "RESPONDED" as const,
			respondedAt: updatedAt,
			updatedAt,
		})),
	};
}

function fakeWorkflowExecutions(): WorkflowExecutionRepository {
	const executionLog = executionLogRecord();
	return {
		assertReadModelReady: vi.fn(async () => undefined),
		getById: vi.fn(async () => null),
		getByDaprInstanceId: vi.fn(async () => null),
		getExecutionWorkspaceKey: vi.fn(async (executionId) => executionId),
		getSessionOwnerContext: vi.fn(async () => ({
			userId: "user-1",
			workflowId: "wf-1",
			projectId: "project-1",
		})),
		getExecutionWorkspaceRoute: vi.fn(async () => ({
			projectId: "project-1",
			userId: "user-1",
			workspaceSlug: "workspace-1",
		})),
		getRunningByWorkflowId: vi.fn(async () => null),
		getLineage: vi.fn(async () => ({
			rootId: "exec-1",
			currentId: "exec-1",
			nodes: [],
		})),
		listActiveForUser: vi.fn(async () => [
			{
				id: "exec-1",
				workflowId: "wf-1",
				workflowName: "Example",
				status: "running" as const,
				phase: "agent",
				approvalEventName: null,
			},
		]),
		listForInternalAgent: vi.fn(async () => ({
			success: true as const,
			executions: [
				{
					id: "exec-1",
					workflowId: "wf-1",
					status: "running" as const,
					phase: "agent",
					progress: 50,
					error: null,
					startedAt: new Date("2026-01-01T00:00:00.000Z"),
					completedAt: null,
					workflow: {
						id: "wf-1",
						name: "Example",
						description: null,
					},
				},
			],
			total: 1,
		})),
		listByWorkflowId: vi.fn(async () => []),
		listRunSummariesByWorkflowId: vi.fn(async () => []),
		listProjectRuns: vi.fn(async () => []),
		countForksByWorkflowIds: vi.fn(async () => []),
		listRecentRunsByWorkflowIds: vi.fn(async () => []),
		listRecentExecutionPickerRecords: vi.fn(async () => []),
		listSessionsForExecutionLineage: vi.fn(async () => []),
		listOutputFilesByExecutionId: vi.fn(async () => ({
			files: [],
			liveSandbox: null,
			cliWorkspace: false,
		})),
		aggregateUsageMetricsForExecutionLineage: vi.fn(async () => []),
		create: vi.fn(async () => ({ id: "exec-1" })),
		attachSchedulerInstance: vi.fn(async () => undefined),
		markStartFailed: vi.fn(async () => undefined),
		listStaleRunningExecutions: vi.fn(async () => []),
		applyRuntimeProjection: vi.fn(async () => ({ applied: true as const })),
		compareAndSetReadModel: vi.fn(async () => null),
		appendLog: vi.fn(async () => executionLog),
    updateLog: vi.fn(async () => ({
      ...executionLog,
      status: "success" as const,
    })),
		listLogsByExecutionId: vi.fn(async () => [executionLog]),
		listLogsByWorkflowSince: vi.fn(async () => [executionLog]),
		listSessionIdsByExecutionId: vi.fn(async () => ["session-1"]),
		countActiveTriggeredRuns: vi.fn(async () => 0),
		listAgentEventsByExecutionId: vi.fn(async () => []),
		listRecentAgentEventsByExecutionId: vi.fn(async () => []),
		listAgentEventsByExecutionIdAfter: vi.fn(async () => []),
	};
}

function executionLogRecord(): WorkflowExecutionLogRecord {
	return {
		id: "log-1",
		executionId: "exec-1",
		nodeId: "agent",
		nodeName: "Agent",
		nodeType: "action",
		activityName: "durable/run",
		status: "running" as const,
		input: {},
		output: null,
		error: null,
		startedAt: new Date("2026-01-01T00:00:00.000Z"),
		completedAt: null,
		duration: null,
		timestamp: new Date("2026-01-01T00:00:00.000Z"),
		credentialFetchMs: null,
		routingMs: null,
		coldStartMs: null,
		executionMs: null,
		routedTo: null,
		wasColdStart: null,
	};
}

function fakeWorkflowScheduler(): WorkflowScheduler {
	return {
		startSwWorkflow: vi.fn(async () => ({
			instanceId: "sw-example-exec-exec-1",
		})),
		startScriptWorkflow: vi.fn(async () => ({
			instanceId: "dsw-example-exec-exec-1",
		})),
	};
}

function fakeWorkflowFiles(): WorkflowFileStore {
	const file = {
		id: "file-1",
		name: "artifact.bin",
		purpose: "output" as const,
		scopeId: "exec-1",
		contentType: "application/octet-stream",
		sizeBytes: 12,
		sha1: "sha1",
		createdAt: "2026-01-01T00:00:00.000Z",
		archivedAt: null,
	};
	return {
		createFile: vi.fn(async () => ({ file, deduplicated: false })),
		listFiles: vi.fn(async () => [file]),
		listFilesByScopePrefix: vi.fn(async () => [file]),
		getFile: vi.fn(async () => file),
    getFileContent: vi.fn(async () => ({
      summary: file,
      bytes: Buffer.from("payload"),
    })),
		archiveFile: vi.fn(async () => true),
		deleteFile: vi.fn(async () => true),
	};
}

function fakeAppConnections(): AppConnectionRepository {
	return {
		listProjectConnections: vi.fn(async () => []),
		listConnectionSummaries: vi.fn(async () => []),
		listPieceInfo: vi.fn(async () => []),
		findConnectionById: vi.fn(async () => null),
		findConnectionByExternalId: vi.fn(async () => null),
		findOAuthPieceMetadata: vi.fn(async () => null),
		findPlatformOAuthApp: vi.fn(async () => null),
		createConnection: vi.fn(async (input) => ({
			id: input.id,
			externalId: input.externalId,
			pieceName: input.pieceName,
			displayName: input.displayName,
			type: input.type,
			status: input.status,
			scope: input.scope,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		})),
		updateDisplayName: vi.fn(async (input) => ({
			id: input.id,
			externalId: "conn_1",
			pieceName: "github",
			displayName: input.displayName,
			type: "SECRET_TEXT",
			status: "ACTIVE",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		})),
		updateOAuthConnection: vi.fn(async (input) => ({
			id: input.id,
			externalId: "conn_1",
			pieceName: input.pieceName,
			displayName: "GitHub",
			type: "PLATFORM_OAUTH2",
			status: "ACTIVE",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		})),
		updateEncryptedValue: vi.fn(async () => undefined),
		deleteProjectConnection: vi.fn(async () => true),
	};
}

function fakeAdminPieces(): AdminPieceRepository {
	return {
		listCatalogPieces: vi.fn(async () => []),
		listDisabledPieceNames: vi.fn(async () => []),
		listWorkflowReferencedPieceNames: vi.fn(async () => []),
		listEnabledMcpPieceNames: vi.fn(async () => []),
		listLatestImageStatuses: vi.fn(async () => []),
		getLatestCatalogPieceVersion: vi.fn(async () => null),
		setPieceEnabled: vi.fn(async () => undefined),
		markPieceImageBuilding: vi.fn(async () => undefined),
		markPieceImageReadyEnabled: vi.fn(async () => undefined),
		recordPieceImageResult: vi.fn(async () => null),
		listBuildingPieceImages: vi.fn(async () => []),
		markPieceRunnable: vi.fn(async () => undefined),
	};
}

function fakeSessionEventNotifications(): WorkflowSessionEventNotificationSource {
	return {
		listenSessionEvents: vi.fn(async () => ({
			unlisten: vi.fn(async () => undefined),
		})),
	};
}

function fakeSessions(): SessionRepository {
	return {
		listSessions: vi.fn(async () => []),
		getSession: vi.fn(async () => null),
		createSession: vi.fn(async () => sampleSessionDetail()),
		ensureSession: vi.fn(async (input) => ({
			session: {
				...sampleSessionDetail(),
				id: input.id,
				title: input.title ?? null,
				agentId: input.agentId,
				agentVersion: input.agentVersion ?? null,
				projectId: input.projectId ?? null,
				workflowExecutionId: input.workflowExecutionId ?? null,
			},
			created: true,
		})),
		updateSessionTitle: vi.fn(async () => null),
		archiveSession: vi.fn(async () => false),
		deleteSession: vi.fn(async () => false),
		listSessionResources: vi.fn(async () => []),
		addSessionResource: vi.fn(async (input) => ({
			id: "resource-1",
			sessionId: input.sessionId,
			type: input.resource.type,
			fileId: input.resource.fileId ?? null,
			mountPath: input.resource.mountPath ?? null,
			repoUrl: input.resource.repoUrl ?? null,
			checkoutRef: input.resource.checkoutRef ?? null,
			authTokenCredentialId: input.resource.authTokenCredentialId ?? null,
			appConnectionExternalId: input.resource.appConnectionExternalId ?? null,
			mountedAt: null,
			removedAt: null,
		})),
    attachWorkspaceSandbox: vi.fn(async () => true),
		recordSandboxProvisioningError: vi.fn(async () => undefined),
		removeSessionResource: vi.fn(async () => false),
		getSessionProvisioningContext: vi.fn(async () => ({
			id: "session-1",
			status: "rescheduling" as const,
			runtimeAppId: "agent-session-1",
			projectId: "project-1",
		})),
		getSessionContextUsage: vi.fn(async () => ({
			sessionId: "session-1",
			usage: { input_tokens: 100 },
			activeContext: { context_used_percentage: 10 },
			lastProviderContext: { model: "openai/gpt-5.5" },
			events: { total: 3, totalBytes: 1024, llmTurns: 1 },
		})),
		getSessionOwnerUserId: vi.fn(async () => "user-1"),
    reserveSessionRuntimeProvisioning: vi.fn(async () => ({
      startedAt: new Date("2026-07-21T20:00:00.000Z"),
    })),
		stageSessionRuntimeProvisioning: vi.fn(async () => true),
		listStaleSessionRuntimeProvisioningTargets: vi.fn(async () => []),
		attachStagedSessionRuntimeProvisioning: vi.fn(async () => true),
		inspectSessionRuntimeHostRecovery: vi.fn(async () => null),
		beginSessionRuntimeHostRecovery: vi.fn(async () => null),
		completeSessionRuntimeHostRecovery: vi.fn(async () => "superseded" as const),
    acknowledgeRuntimeProvisioningCompensation: vi.fn(async () => true),
		canCompensateRuntimeProvisioning: vi.fn(async () => true),
		canReleaseRuntimeProvisioning: vi.fn(async () => true),
		releaseSessionRuntimeProvisioning: vi.fn(async () => true),
    attachSessionRuntime: vi.fn(async () => true),
		getSessionRuntimeTarget: vi.fn(async () => ({
			appId: "agent-session-1",
			invokeTarget: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
			source: "persisted" as const,
		})),
		getSessionRuntimeDebugTarget: vi.fn(async () => ({
			appId: "agent-session-1",
			invokeTarget: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
			source: "persisted" as const,
			agentSlug: "codex-agent",
			agentRuntime: "codex-cli",
		})),
		getBrowserSessionTarget: vi.fn(async () => ({
			sessionId: "session-1",
			agentSlug: "browser-agent",
		})),
		listCliWorkspaceSessionCandidates: vi.fn(async () => []),
		listLivenessReconcileCandidates: vi.fn(async () => []),
		listWorkflowExecutionSessionRuntimes: vi.fn(async () => []),
		listSandboxSessionOwners: vi.fn(async () => []),
		getWorkflowEnsureSession: vi.fn(async () => ({
			id: "session-1",
			agentId: "agent-1",
			agentVersion: 2,
			userId: "user-1",
			projectId: "project-1",
			vaultIds: ["vault-1"],
			workflowExecutionId: "exec-1",
			parentExecutionId: "parent-1",
			sandboxName: "sandbox-1",
			runtimeAppId: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
		})),
		createWorkflowEnsureSession: vi.fn(async () => ({
			startedAt: new Date("2026-07-21T20:00:00.000Z"),
		})),
    updateWorkflowEnsureSessionRuntime: vi.fn(async () => true),
		listReapableWorkflowSessionRuntimeHosts: vi.fn(async () => [
			{ sessionId: "session-old", runtimeAppId: "agent-session-old" },
		]),
		createSessionFork: vi.fn(async () => ({ id: "fork-session-1" })),
		getPeerSession: vi.fn(async () => null),
		createPeerSession: vi.fn(async (input) => ({
			status: "ok" as const,
			created: true,
			session: {
			id: input.id,
				status: "rescheduling" as const,
			agentId: input.agentId,
			agentVersion: 3,
			environmentId: "env-1",
			environmentVersion: 4,
			vaultIds: ["vault-1"],
			daprInstanceId: null,
			natsSubject: null,
			runtimeAppId: null,
			runtimeProvisioningStartedAt: null,
				workflowExecutionId: input.workflowExecutionId,
      parentExecutionId: input.parentExecutionId,
				stopRequestedAt: null,
				completedAt: null,
			},
		})),
		findSessionIdByDaprInstanceId: vi.fn(async () => "session-1"),
		resolveSessionIdForProvisioningEvent: vi.fn(async () => "session-1"),
		getSessionFileOwner: vi.fn(async () => ({
			id: "session-1",
			userId: "user-1",
			projectId: "project-1",
		})),
		getSessionWorkflowContext: vi.fn(async () => ({
			workflowExecutionId: "exec-1",
			parentExecutionId: "parent-exec-1",
			daprInstanceId: "dapr-session-1",
		})),
		updateSessionStatus: vi.fn(async () => undefined),
		updateSessionStatusUnlessTerminated: vi.fn(async () => undefined),
		updateSessionStatusRescheduled: vi.fn(async () => undefined),
		bumpSessionLastEventAt: vi.fn(async () => undefined),
		setSessionPendingInput: vi.fn(async () => undefined),
	};
}

function sampleSessionDetail(): SessionDetail {
	return {
		id: "session-1",
		title: "Session 1",
		status: "rescheduling",
		stopReason: null,
		agentId: "agent-1",
		agentVersion: 1,
		projectId: "project-1",
		environmentId: null,
		environmentVersion: null,
		vaultIds: [],
		usage: {},
		errorMessage: null,
		workflowExecutionId: null,
		mlflowExperimentId: null,
		mlflowRunId: null,
		mlflowParentRunId: null,
		mlflowSessionId: "session-1",
		workflowId: null,
		workflowName: null,
		agentName: "Agent One",
		agentSlug: "agent-one",
		agentAvatar: null,
		agentEphemeral: false,
		createdAt: "2026-05-15T12:00:00.000Z",
		updatedAt: "2026-05-15T12:00:00.000Z",
		lastEventAt: null,
		pendingInput: null,
		completedAt: null,
		archivedAt: null,
		daprInstanceId: null,
		natsSubject: null,
		parentExecutionId: null,
		resumedFromSessionId: null,
		sandboxName: "dapr-agent-py",
		workspaceSandboxName: null,
		runtimeAppId: null,
		runtimeSandboxName: null,
		pausedAt: null,
	};
}

function fakeSessionProvisioning(): SessionProvisioningReader {
	return {
		getSessionProvisioning: vi.fn(async () => ({
			phase: "starting" as const,
			label: "Starting containers",
			detail: null,
			podName: "agent-host-session-1",
			podPhase: "Running",
			source: "observer" as const,
		})),
	};
}

function fakeSessionEvents(): SessionEventLog {
	return {
		appendSessionEvent: vi.fn(async (sessionId, event) => ({
			id: "event-1",
			sessionId,
			sequence: 1,
			type: event.type,
			data: event.data ?? {},
			processedAt: event.processedAt?.toISOString() ?? null,
			sourceEventId: event.sourceEventId ?? null,
			producerId: event.producerId ?? null,
			producerEpoch: event.producerEpoch ?? null,
			createdAt: "2026-01-01T00:00:00.000Z",
			timestamp: "2026-01-01T00:00:00.000Z",
		})),
		getSessionEvent: vi.fn(async (input) => ({
			id: input.eventId,
			sessionId: input.sessionId,
			sequence: 1,
			type: "user.message",
			data: { content: "full payload" },
			processedAt: null,
			sourceEventId: null,
			producerId: null,
			producerEpoch: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			timestamp: "2026-01-01T00:00:00.000Z",
		})),
		listSessionEvents: vi.fn(async () => []),
		claimUnraisedTeamEvents: vi.fn(async () => []),
			hasUnprocessedTeamEvents: vi.fn(async () => false),
			completeTeamEventDelivery: vi.fn(async () => 0),
			releaseTeamEventDeliveryClaim: vi.fn(async () => 0),
	};
}

function fakeGoalFlow(): GoalFlowReadStore {
	return {
		getCurrentGoalForSessions: vi.fn(async (sessionIds) => ({
			sessionId: sessionIds[0] ?? "session-1",
			goalId: "goal-1",
			objective: "Ship the migration",
			status: "complete",
			iterations: 1,
			maxIterations: 5,
			tokensUsed: 42,
			tokenBudget: null,
			stopReason: "complete",
			acceptanceCriteria: ["tests pass"],
			evidencePlan: { commands: ["pnpm check"] },
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			completedAt: new Date("2026-01-01T00:05:00.000Z"),
		})),
		listGoalFlowEvents: vi.fn(async () => [
			{
				sequence: 1,
				type: "agent.message",
				data: { content: "working" },
				createdAt: new Date("2026-01-01T00:01:00.000Z"),
			},
			{
				sequence: 2,
				type: "agent.llm_usage",
				data: { input_tokens: 10, output_tokens: 20 },
				createdAt: new Date("2026-01-01T00:02:00.000Z"),
			},
			{
				sequence: 3,
				type: "session.goal_completed",
				data: { completionSource: "evidence" },
				createdAt: new Date("2026-01-01T00:05:00.000Z"),
			},
		]),
	};
}

function fakeSessionRuntimeConfigs(): SessionRuntimeConfigReader {
	return {
		getSessionRuntimeConfig: vi.fn(async (input) => {
			const event = {
				specversion: "1.0",
				id: `runtime-config:${input.sessionId}`,
				source: "urn:test",
				type: "io.workflow-builder.session.runtime_config.v1",
				subject: `sessions/${input.sessionId}/turns/0`,
				datacontenttype: "application/json",
				data: {
					schemaVersion: "workflow-builder.agent_runtime_config.v1",
					source: "settings",
					sessionId: input.sessionId,
					instanceId: input.sessionId,
					turn: 0,
					configRevision: 0,
					configHash: "config-hash",
					agent: {},
					llm: {},
					execution: {},
					tools: {},
					mcp: {},
					skills: [],
					instructions: {},
					mlflow: {},
					dapr: {},
					attributes: {},
				},
			} satisfies RuntimeConfigCloudEvent;
			return event;
		}),
	};
}

function fakeSessionExperimentAgents(): SessionExperimentAgentStore {
	return {
		resolveSessionForkBaseAgent: vi.fn(async () => ({
			id: "agent-1",
			slug: "base-agent",
			name: "Base Agent",
			config: createDefaultAgentConfig(),
		})),
		findOrCreateSessionExperimentAgent: vi.fn(async () => ({
			agentId: "experiment-agent-1",
			agentVersion: 1,
		})),
	};
}

function fakeSessionRuntimeEvents(): SessionRuntimeEventRaiser {
	return {
		raiseSessionUserEvents: vi.fn(async (_sessionId, _events, delivery) => ({
			accepted: true as const,
			deliveryId: delivery?.batchId ?? null,
		})),
	};
}

function fakeSessionAgentConfigCommands(): SessionAgentConfigCommandPort {
	return {
		raiseSessionAgentConfigPatch: vi.fn(async (input) => ({
			ok: true,
			status: 200,
			patch:
				typeof input.patch === "object" &&
				input.patch !== null &&
				!Array.isArray(input.patch)
					? { ...(input.patch as Record<string, unknown>) }
					: {},
		})),
	};
}

function fakeCodeCheckpoints(): WorkflowCodeCheckpointStore {
	return {
		persistFromAgentEvent: vi.fn(async () => undefined),
		listForExecution: vi.fn(async () => []),
		getForExecution: vi.fn(async () => null),
	};
}

function fakeEvaluationArtifacts(): EvaluationArtifactStore {
	return {
		recordCodeCheckpointWarning: vi.fn(async () => undefined),
	};
}

function fakePeerAgentResolver(): PeerAgentResolver {
	return {
		resolvePeerAgentOwner: vi.fn(async () => ({
			userId: "peer-owner-1",
			projectId: "peer-project-1",
		})),
		resolvePeerAgentDispatchContext: vi.fn(async () => ({
			agentConfig: {
				...createDefaultAgentConfig(),
				systemPrompt: "You are a peer",
			},
			environmentConfig: { image: "env-image" },
			callableAgents: [
				{
					slug: "reviewer",
					agentId: "agent-reviewer",
					version: 2,
					appId: "dapr-agent-py",
					team: "project-1",
					registryKey: "project-1/reviewer",
				},
			],
			registryTeam: "project-1",
		})),
	};
}

function fakeSessionAgentResolver(): SessionAgentResolver {
	return {
		resolveSessionAgent: vi.fn(async (input) => ({
			id: input.agentId,
			name: "CLI Dev Agent",
			slug: "cli-dev-agent",
			version: input.agentVersion ?? 7,
			configHash: "agent-config-hash",
			projectId: "project-1",
			config: createDefaultAgentConfig(),
			environmentId: null,
			environmentVersion: null,
			defaultVaultIds: [],
			runtime: "codex-cli",
			runtimeAppId: "agent-runtime-cli-dev-agent",
			mlflowModelVersion: null,
			mlflowModelName: null,
			mlflowUri: null,
		})),
	};
}

function fakePreviewDevSessionAgentResolver(
	overrides: {
		slug?: string;
		rowRuntime?: string;
		config?: Partial<AgentConfig> & {
			reasoningEffort?: string;
			contextWindowTokens?: number;
		};
	} = {},
): SessionAgentResolver {
	const base = fakeSessionAgentResolver();
	return {
		resolveSessionAgent: vi.fn(async (input) => {
			const agent = await base.resolveSessionAgent(input);
			if (!agent) return null;
			const config = {
				...agent.config,
				runtime: "dapr-agent-py-juicefs",
				modelSpec: overrides.config?.modelSpec ?? "deepseek-v4-pro",
				...overrides.config,
			} as AgentConfig & {
				reasoningEffort?: string;
				contextWindowTokens?: number;
			};
			return {
				...agent,
				slug: overrides.slug ?? "dapr-juicefs-dev-agent",
				runtime: overrides.rowRuntime ?? "dapr-agent-py-juicefs",
				config,
			};
		}),
	};
}

function fakeSessionAgentSlugs(): SessionAgentSlugResolver {
	return {
		resolveSessionAgentIdBySlug: vi.fn(async () => "agent-1"),
	};
}

function expectedWorkflowDevSessionId(executionId: string): string {
	const digest = createHash("sha256").update(executionId, "utf8").digest("hex");
	return `preview-dev-${digest.slice(0, 32)}`;
}

function fakeWorkflowAgentReads(): WorkflowAgentReadRepository {
	return {
		getWorkflowAgentRuntimeIdentity: vi.fn(async (agentId) => ({
			agentId,
			slug: "test-agent",
			runtimeAppId: "agent-runtime-test-agent",
			appId: "agent-runtime-test-agent",
		})),
		resolvePublishedWorkflowAgentForEnsure: vi.fn(async (input) => {
			if (!input.agentId) return null;
			return {
				ok: true as const,
				agent: {
					agentId: input.agentId,
					agentVersion: input.agentVersion ?? 3,
					agentSlug: "published-agent",
					agentAppId: "agent-runtime-published-agent",
					mlflowUri: "models:/published-agent/3",
					mlflowModelName: "published-agent",
					mlflowModelVersion: "model-3",
				},
			};
		}),
		resolveSessionControlSettingsReferences: vi.fn(async (input) => ({
			agent: {
				id: input.agentId,
				slug: "settings-agent",
				version: input.agentVersion ?? 1,
				config: createDefaultAgentConfig(),
			},
			environment: input.environmentId
				? {
						id: input.environmentId,
						slug: "settings-environment",
						version: input.environmentVersion ?? 1,
						config: { image: "sandbox:latest" },
					}
				: null,
		})),
	};
}

function fakeRuntimeRegistry(): RuntimeRegistryReader {
	const cliAuthByRuntime = {
		"codex-cli": {
			provider: "openai",
			credentialKind: "file",
			setupCommand: "codex login",
		},
		"agy-cli": {
			provider: "google",
			credentialKind: "file_bundle",
			setupCommand: "agy login",
		},
	} satisfies Record<string, SessionRuntimeCliAuthReadModel>;
	return {
		listSessionRuntimeCliAuth: vi.fn(async () => cliAuthByRuntime),
		getStructuredOutputCapability: vi.fn(async () => null),
	};
}

function fakeSessionRuntimeStatus(): SessionRuntimeStatusReader {
	return {
		getSessionRuntimeCompute: vi.fn(async (target) => ({
			podName: `${target.appId}-pod`,
			usage: {
				name: `${target.appId}-pod`,
				cpuMillicores: 123,
				memoryMiB: 456,
			},
			requests: {
				cpuMillicores: 1000,
				memoryMiB: 2048,
			},
		})),
		getSessionRuntimeFlags: vi.fn(async (target) => ({
			agentSlug: target.agentSlug,
			runtimeAppId: target.appId,
			runtimeSandboxName: target.runtimeSandboxName,
			browserSidecarEnabled: true,
			browserMcpAvailable: true,
			shellAvailable: true,
			shellContainers: ["sandbox"],
			interactiveTerminal: false,
			nativeGoalAvailable: false,
			cliLabel: null,
			phase: "Active",
		})),
	};
}

function fakeWorkspaceProjects(): WorkspaceProjectRepository {
	const createdAt = new Date("2026-01-01T00:00:00.000Z");
	const updatedAt = new Date("2026-01-01T00:00:00.000Z");
	return {
    hasActiveProjectMembership: vi.fn(async () => true),
		getMemberProjectId: vi.fn(async () => "project-1"),
		getFallbackMemberProjectId: vi.fn(async () => "project-1"),
		listWorkspaceMemberships: vi.fn(async () => [
			{
				id: "project-1",
				displayName: "Project One",
				externalId: "workspace-1",
				role: "ADMIN" as const,
				createdAt,
			},
		]),
		createWorkspaceProject: vi.fn(async (input) => ({
			id: "project-created",
			displayName: input.displayName,
			externalId: input.externalId,
			role: "ADMIN" as const,
			createdAt,
		})),
		updateWorkspaceDisplayName: vi.fn(async () => true),
		getMemberProjectIdBySlug: vi.fn(async () => "project-1"),
		getProjectExternalId: vi.fn(async () => "workspace-1"),
		getProjectMembershipDetail: vi.fn(async () => null),
		getProjectMemberRole: vi.fn(async () => "ADMIN" as const),
		listProjectMembers: vi.fn(async () => [
			{
				id: "member-1",
				userId: "user-1",
				name: "Ada",
				email: "ada@example.test",
				image: null,
				role: "ADMIN" as const,
				createdAt,
			},
		]),
    findPlatformUserForProject: vi.fn(async () => ({
      ok: true as const,
      userId: "user-2",
    })),
		getProjectMember: vi.fn(async () => ({
			id: "member-1",
			projectId: "project-1",
			userId: "user-1",
			role: "ADMIN" as const,
			createdAt,
			updatedAt,
		})),
		projectMemberExists: vi.fn(async () => false),
		countProjectAdmins: vi.fn(async () => 2),
		addProjectMember: vi.fn(async (input) => ({
			id: "member-2",
			projectId: input.projectId,
			userId: input.userId,
			role: input.role,
			createdAt,
			updatedAt,
		})),
		updateProjectMemberRole: vi.fn(async (input) => ({
			id: input.memberId,
			projectId: input.projectId,
			userId: "user-2",
			role: input.role,
			createdAt,
			updatedAt,
		})),
		deleteProjectMember: vi.fn(async () => undefined),
	};
}

function fakePieceCatalog(): PieceCatalogRepository {
	return {
		getLatestPieceMetadata: vi.fn(async () => null),
		listConnectablePieces: vi.fn(async () => [
			{
				name: "github",
				displayName: "GitHub",
				logoUrl: "https://example.test/github.svg",
				authType: "OAUTH2",
			},
		]),
		listPieceCatalogFunctions: vi.fn(async () => [
			{
				name: "github-create_issue",
				version: "1.0.0",
				displayName: "Create Issue",
				description: "Create a GitHub issue",
				pieceName: "github",
				actionName: "create_issue",
				providerId: "github",
				providerLabel: "GitHub",
				providerIconUrl: "https://example.test/github.svg",
				category: "developer-tools",
				entrypoint: "create_issue",
			},
		]),
		listMcpCatalogPieces: vi.fn(async () => []),
		listConnectionUsageByPieceNames: vi.fn(async () => []),
	};
}

function fakeCodeFunctionCatalog(): CodeFunctionCatalogRepository {
	return {
		listEnabledForCatalog: vi.fn(async () => [
			{
				id: "code-1",
				name: "Summarize",
				slug: "summarize",
				description: "Summarize text",
				version: "1",
				latestPublishedVersion: "2",
				entrypoint: "main",
				language: "typescript",
			},
		]),
	};
}

function fakeBenchmarkBrowser(): BenchmarkBrowserRepository {
	return {
		ensureDefaultSuites: vi.fn(async () => undefined),
		listInstances: vi.fn(async () => []),
		listRepoFacets: vi.fn(async () => []),
		listSuites: vi.fn(async () => []),
		listEnvironmentBuilds: vi.fn(async () => []),
		listRunnableAgentCandidates: vi.fn(async () => []),
	};
}

function fakeDevEnvironments(): DevEnvironmentReadRepository {
	return {
		listServices: vi.fn(() => [
			{
				service: "workflow-builder",
				primaryCluster: "dev",
				previewTier: "tier-1-hot-loop",
				needsDapr: true,
				port: 3000,
				syncMode: "plugin",
				repoUrl: "PittampalliOrg/workflow-builder",
				repoSubdir: ".",
				tailnetHost: "wfb-preview-dev.example.ts.net",
			},
		]),
		listDevEnvironments: vi.fn(async () => [
			{
				executionId: "exec-1",
				workspaceRef: "workspace-1",
				service: "workflow-builder",
				browseUrl: "https://preview.example.test",
				podIP: "10.0.0.10",
				port: 3000,
				syncUrl: null,
				ready: true,
				needsDapr: true,
				daprAppId: "workflow-builder-preview",
				sandboxName: "sandbox-1",
				sessionId: "session-1",
				sessionUrl: "/sessions/session-1",
				runStatus: "running",
				createdAt: "2026-07-02T00:00:00.000Z",
			},
		]),
		listDevEnvironmentGroups: vi.fn(async () => []),
		getDevEnvironmentOrPending: vi.fn(async (input) => ({
			executionId: input.executionId,
			workspaceRef: "workspace-1",
			service: "workflow-builder",
			browseUrl: "https://preview.example.test",
			podIP: null,
			port: 3000,
			syncUrl: null,
			ready: false,
			needsDapr: true,
			daprAppId: null,
			sandboxName: "sandbox-1",
			sessionId: "session-1",
			sessionUrl: "/sessions/session-1",
			runStatus: "running",
			createdAt: "2026-07-02T00:00:00.000Z",
		})),
		getDevEnvironmentTeardownTarget: vi.fn(async (input) => ({
			executionId: input.executionId,
			workspaceRef: "workspace-1",
			service: "workflow-builder",
			browseUrl: "https://preview.example.test",
			podIP: null,
			port: 3000,
			syncUrl: null,
			ready: false,
			needsDapr: true,
			daprAppId: null,
			sandboxName: "sandbox-1",
			sessionId: "session-1",
			sessionUrl: "/sessions/session-1",
			runStatus: "cancelled",
			createdAt: "2026-07-02T00:00:00.000Z",
		})),
		resolveCanonicalExecutionId: vi.fn(async (input) =>
			input.executionId === "sw-wf-1-exec-exec-1"
				? "exec-1"
				: input.executionId,
		),
	};
}

function fakeBenchmarkRuns(): BenchmarkRunRepository {
	return {
		getProjectId: vi.fn(async () => "project-1"),
		getSessionProvisioningGate: vi.fn(async () => ({
			runStatus: "inferencing",
			summary: { execution: { class: "gpu-large" } },
			instanceStatus: "queued",
			inferenceStatus: "inferencing",
		})),
	};
}

function fakeBenchmarkRunReads(): BenchmarkRunReadRepository {
	return {
		listRuns: vi.fn<BenchmarkRunReadRepository["listRuns"]>(async (input) => {
			const runs = [
				{
					id: "run-1",
					suiteId: "suite-1",
					suiteSlug: "SWE-bench_Verified",
					suiteName: "SWE-bench Verified",
					datasetName: "SWE-bench",
					agentId: "agent-1",
					agentName: "Agent One",
					agentSlug: "agent-one",
					agentVersion: 3,
					agentRuntimeAppId: "agent-runtime-agent-one",
					status: "completed",
					modelNameOrPath: "model-a",
					modelConfigLabel: "label-a",
					selectedInstanceIds: ["inst-1"],
					concurrency: 1,
					evaluationConcurrency: 1,
					timeoutSeconds: 3600,
					maxTurns: 25,
					evaluatorResourceClass: "standard",
					coordinatorExecutionId: null,
					evaluatorJobName: null,
					predictionsPath: null,
					mlflowExperimentId: null,
					mlflowRunId: null,
					mlflowDatasetId: null,
					mlflowEvalRunId: null,
					mlflowTraceExperimentName: null,
					mlflowUrl: null,
					summary: { total: 1, resolved: 1 },
					tags: ["campaign-a"],
					error: null,
					cancelRequestedAt: null,
					startedAt: "2026-07-02T00:00:00.000Z",
					completedAt: "2026-07-02T00:30:00.000Z",
					createdAt: "2026-07-02T00:00:00.000Z",
					updatedAt: "2026-07-02T00:30:00.000Z",
				},
				{
					id: "run-2",
					suiteId: "suite-1",
					suiteSlug: "SWE-bench_Verified",
					suiteName: "SWE-bench Verified",
					datasetName: "SWE-bench",
					agentId: "agent-2",
					agentName: "Agent Two",
					agentSlug: "agent-two",
					agentVersion: 1,
					agentRuntimeAppId: "agent-runtime-agent-two",
					status: "running",
					modelNameOrPath: "model-b",
					modelConfigLabel: null,
					selectedInstanceIds: ["inst-1"],
					concurrency: 2,
					evaluationConcurrency: 1,
					timeoutSeconds: 3600,
					maxTurns: null,
					evaluatorResourceClass: "standard",
					coordinatorExecutionId: "coord-1",
					evaluatorJobName: null,
					predictionsPath: null,
					mlflowExperimentId: null,
					mlflowRunId: null,
					mlflowDatasetId: null,
					mlflowEvalRunId: null,
					mlflowTraceExperimentName: null,
					mlflowUrl: null,
					summary: { total: 1, resolved: 0 },
					tags: input.tag ? [input.tag] : ["campaign-a", "campaign-b"],
					error: null,
					cancelRequestedAt: null,
					startedAt: "2026-07-02T01:00:00.000Z",
					completedAt: null,
					createdAt: "2026-07-02T01:00:00.000Z",
					updatedAt: "2026-07-02T01:05:00.000Z",
				},
			];
      return input.tag
        ? runs.filter((run) => run.tags.includes(input.tag!))
        : runs;
		}),
		loadCompareData: vi.fn<BenchmarkRunReadRepository["loadCompareData"]>(
			async (input) => ({
			runs: input.runIds.map((runId, index) => ({
				runId,
				suiteSlug: "SWE-bench_Verified",
				suiteName: "SWE-bench Verified",
				createdAt: "2026-07-02T00:00:00.000Z",
				agent: {
					id: `agent-${index + 1}`,
					slug: `agent-${index + 1}`,
					name: `Agent ${index + 1}`,
				},
				agentVersion: 1,
				model: `model-${index + 1}`,
				modelLabel: null,
				mcpServerNames: [],
				skillNames: [],
				hookNames: [],
				pluginNames: [],
				maxTurns: null,
				concurrency: 1,
				evaluationConcurrency: 1,
				evaluatorResourceClass: "standard",
				resolved: index === 0 ? 1 : 0,
				total: 1,
				resolvedRate: index === 0 ? 1 : 0,
				status: "completed",
			})),
			axisDiff: {
				agent: { differs: true, values: input.runIds },
				agentVersion: { differs: false, values: [1, 1] },
				model: { differs: true, values: ["model-1", "model-2"] },
				modelLabel: { differs: false, values: [null, null] },
				mcpServerNames: { differs: false, values: [[], []] },
				skillNames: { differs: false, values: [[], []] },
				hookNames: { differs: false, values: [[], []] },
				pluginNames: { differs: false, values: [[], []] },
				maxTurns: { differs: false, values: [null, null] },
				concurrency: { differs: false, values: [1, 1] },
				evaluationConcurrency: { differs: false, values: [1, 1] },
          evaluatorResourceClass: {
            differs: false,
            values: ["standard", "standard"],
          },
			},
			grid: {
				[input.runIds[0] ?? "run-1"]: {
					"inst-1": {
						status: "resolved",
						resolved: true,
						durationMs: 1000,
						tokens: 10,
						error: null,
						sessionId: "session-1",
					},
				},
			},
			allInstanceIds: ["inst-1"],
			sharedInstanceIds: ["inst-1"],
			disagreements: [],
			regression: [],
			}),
		),
	};
}

function fakeUsageReporting(): UsageReportingRepository {
	return {
		getUsageAnalytics: vi.fn(async () => ({
			totals: {
				tokensIn: 1000,
				tokensOut: 250,
				cacheReadTokens: 100,
				cacheCreateTokens: 50,
				sessionCount: 3,
				toolCalls: 2,
			},
			daily: [{ day: "2026-07-01", tokensIn: 1000, tokensOut: 250 }],
			byAgent: [
				{
					agentId: "agent-1",
					agentName: "Agent One",
					tokensIn: 1000,
					tokensOut: 250,
					sessions: 3,
				},
			],
		})),
		listCostUsageRows: vi.fn(async () => [
			{
				agentId: "agent-1",
				agentName: "Agent One",
				modelSpec: "anthropic/claude-opus-4-8",
				sessions: 2,
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				cacheReadTokens: 500_000,
				cacheCreateTokens: 200_000,
			},
		]),
		getLiveLimitSnapshot: vi.fn(async () => ({
			activeSessions: 1,
			byModel: [
				{
					model: "claude-opus-4-8",
					sessionsLastHour: 2,
					tokensInLastHour: 1000,
					tokensOutLastHour: 250,
					tokensInLastMinute: 100,
					tokensOutLastMinute: 25,
				},
			],
		})),
	};
}

function fakeSandboxInventory(): SandboxInventoryRepository {
	return {
		listRecentExecutionsForSandbox: vi.fn(async () => [
			{
				executionId: "exec-1",
				workflowId: "wf-1",
				workflowName: null,
				status: "completed",
				startedAt: new Date("2026-07-01T00:00:00.000Z"),
				completedAt: null,
			},
		]),
		countExecutionsSince: vi.fn(async () => 7),
	};
}

function fakeSandboxRuntimeInventory(): SandboxRuntimeInventory {
	return {
		listSandboxes: vi.fn(async () => [
			{
				name: "sandbox-ready",
				phase: "READY",
				createdAt: "2026-07-02T11:30:00.000Z",
			},
			{
				name: "sandbox-provisioning",
				phase: "PROVISIONING",
				createdAt: "2026-07-02T11:00:00.000Z",
			},
		]),
	};
}

function makeService(options: {
	byId?: WorkflowDefinition | null;
	byName?: WorkflowDefinition | null;
	workflowExecutions?: Partial<WorkflowExecutionRepository>;
	benchmarkRunReads?: BenchmarkRunReadRepository;
	benchmarkRuns?: BenchmarkRunRepository;
	benchmarkDatasetPromotions?: BenchmarkDatasetPromotionRepository;
	benchmarkInstanceDetails?: BenchmarkInstanceDetailReadRepository;
	benchmarkRunInstanceDetails?: BenchmarkRunInstanceDetailReadRepository;
	benchmarkRunInstanceAnnotations?: BenchmarkRunInstanceAnnotationRepository;
	benchmarkRunInstanceProgress?: BenchmarkRunInstanceProgressReadRepository;
	benchmarkRunInstanceScores?: BenchmarkRunInstanceScoreReadRepository;
	benchmarkArtifactMetadata?: BenchmarkArtifactMetadataRepository;
	benchmarkEvaluationResults?: BenchmarkEvaluationResultRepository;
	benchmarkRunLifecycle?: BenchmarkRunLifecyclePort;
	benchmarkEvaluationTelemetry?: BenchmarkEvaluationTelemetryPort;
	benchmarkEvaluationEvents?: BenchmarkEvaluationEventNotifier;
	activityRateTargets?: WorkflowActivityRateTargetRepository;
	observabilityTraces?: ObservabilityTraceRepository;
	workflowMonitorReads?: WorkflowMonitorReadRepository;
	resourceUsages?: ResourceUsageReadRepository;
	aiAssistantMessages?: WorkflowAiAssistantMessageRepository;
	securityAudit?: SecurityAuditReadRepository;
	dashboard?: DashboardReadRepository;
	pieceExecutions?: PieceExecutionRepository;
	browserArtifacts?: WorkflowBrowserArtifactStore;
	sessions?: SessionRepository;
	devEnvironments?: DevEnvironmentReadRepository;
	sessionProvisioning?: SessionProvisioningReader;
	sessionEvents?: SessionEventLog;
	sessionRuntimeConfigs?: SessionRuntimeConfigReader;
	sessionRuntimeEvents?: SessionRuntimeEventRaiser;
	sessionAgents?: SessionAgentResolver;
	sessionAgentSlugs?: SessionAgentSlugResolver;
	sessionAgentConfigCommands?: SessionAgentConfigCommandPort;
	codeCheckpoints?: WorkflowCodeCheckpointStore;
	evaluationArtifacts?: EvaluationArtifactStore;
	peerAgentResolver?: PeerAgentResolver;
	workflowAgentReads?: WorkflowAgentReadRepository;
	runtimeRegistry?: RuntimeRegistryReader;
	sessionRuntimeStatus?: SessionRuntimeStatusReader;
	sessionExperimentAgents?: SessionExperimentAgentStore;
	goalFlow?: GoalFlowReadStore;
	userProfiles?: UserProfileRepository;
	workspaceProjects?: WorkspaceProjectRepository;
	homePageReads?: HomePageReadRepository;
}) {
	const workflowDefinitions = {
		getById: vi.fn(async () => options.byId ?? null),
		getLatestByName: vi.fn(async () => options.byName ?? null),
    getLatestByNameInProject: vi.fn(async () => options.byName ?? null),
		getByRef: vi.fn(async () => null),
		list: vi.fn(async () => []),
		listForWorkspace: vi.fn(async () => []),
		findProjectWorkflowIdByIdOrNamePrefix: vi.fn<
			WorkflowDefinitionRepository["findProjectWorkflowIdByIdOrNamePrefix"]
		>(async () => null),
		create: vi.fn(async () => baseWorkflow),
		update: vi.fn(async () => baseWorkflow),
		hasActiveExecutions: vi.fn(async () => false),
		delete: vi.fn(async () => undefined),
	} satisfies WorkflowDefinitionRepository;
	const workflowTriggers = fakeWorkflowTriggers();
  const workflowExecutions = (options.workflowExecutions ??
    {}) as WorkflowExecutionRepository;

	const service = new ApplicationWorkflowDataService({
		workflowDefinitions,
		workflowTriggers,
		userProfiles: options.userProfiles ?? fakeUserProfiles(),
		settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
		adminPieces: fakeAdminPieces(),
		apiKeys: fakeApiKeys(),
		workspaceProjects: options.workspaceProjects ?? fakeWorkspaceProjects(),
		pieceCatalog: fakePieceCatalog(),
		pieceExecutions: options.pieceExecutions,
		sessions: options.sessions,
		browserArtifacts: options.browserArtifacts,
		benchmarkBrowser: fakeBenchmarkBrowser(),
		benchmarkArtifactMetadata: options.benchmarkArtifactMetadata,
		benchmarkEvaluationResults: options.benchmarkEvaluationResults,
		benchmarkRunLifecycle: options.benchmarkRunLifecycle,
		benchmarkEvaluationTelemetry: options.benchmarkEvaluationTelemetry,
		benchmarkEvaluationEvents: options.benchmarkEvaluationEvents,
		benchmarkDatasetPromotions: options.benchmarkDatasetPromotions,
		benchmarkInstanceDetails: options.benchmarkInstanceDetails,
		benchmarkRunInstanceDetails: options.benchmarkRunInstanceDetails,
		benchmarkRunInstanceAnnotations: options.benchmarkRunInstanceAnnotations,
		benchmarkRunInstanceProgress: options.benchmarkRunInstanceProgress,
		benchmarkRunInstanceScores: options.benchmarkRunInstanceScores,
		benchmarkRunReads: options.benchmarkRunReads ?? fakeBenchmarkRunReads(),
		devEnvironments: options.devEnvironments ?? fakeDevEnvironments(),
		benchmarkRuns: options.benchmarkRuns ?? fakeBenchmarkRuns(),
		activityRateTargets: options.activityRateTargets,
		observabilityTraces: options.observabilityTraces,
		workflowMonitorReads: options.workflowMonitorReads,
		resourceUsages: options.resourceUsages,
		aiAssistantMessages: options.aiAssistantMessages,
		securityAudit: options.securityAudit,
		dashboard: options.dashboard,
		homePageReads: options.homePageReads ?? fakeHomePageReads(),
		workflowExecutions,
		sessionEvents: options.sessionEvents,
		sessionRuntimeConfigs:
			options.sessionRuntimeConfigs ?? fakeSessionRuntimeConfigs(),
		sessionRuntimeEvents:
			options.sessionRuntimeEvents ?? fakeSessionRuntimeEvents(),
		sessionAgents: options.sessionAgents ?? fakeSessionAgentResolver(),
		sessionAgentSlugs: options.sessionAgentSlugs ?? fakeSessionAgentSlugs(),
		sessionAgentConfigCommands:
			options.sessionAgentConfigCommands ?? fakeSessionAgentConfigCommands(),
		sessionProvisioning: options.sessionProvisioning,
		codeCheckpoints: options.codeCheckpoints,
		evaluationArtifacts: options.evaluationArtifacts,
		peerAgentResolver: options.peerAgentResolver,
		workflowAgentReads: options.workflowAgentReads ?? fakeWorkflowAgentReads(),
		runtimeRegistry: options.runtimeRegistry ?? fakeRuntimeRegistry(),
		sessionRuntimeStatus:
			options.sessionRuntimeStatus ?? fakeSessionRuntimeStatus(),
		sessionExperimentAgents:
			options.sessionExperimentAgents ?? fakeSessionExperimentAgents(),
		goalFlow: options.goalFlow ?? fakeGoalFlow(),
		sessionEventNotifications: fakeSessionEventNotifications(),
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
	});

	return { service, workflowDefinitions, workflowTriggers, workflowExecutions };
}

function makeServiceWithMcp(mcpConnections: McpConnectionRepository) {
	return new ApplicationWorkflowDataService({
		workflowDefinitions: makeService({}).workflowDefinitions,
		workflowTriggers: fakeWorkflowTriggers(),
		userProfiles: fakeUserProfiles(),
		settings: fakeSettings(),
		mcpConnections,
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
		adminPieces: fakeAdminPieces(),
		apiKeys: fakeApiKeys(),
		workspaceProjects: fakeWorkspaceProjects(),
		pieceCatalog: fakePieceCatalog(),
		benchmarkBrowser: fakeBenchmarkBrowser(),
		workflowExecutions: {} as WorkflowExecutionRepository,
		sessionEventNotifications: fakeSessionEventNotifications(),
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
	});
}

function makeServiceWithPieceCatalog(
	pieceCatalog: PieceCatalogRepository,
	mcpConnections: McpConnectionRepository = fakeMcpConnections(),
	appConnections: AppConnectionRepository = fakeAppConnections(),
	codeFunctionCatalog: CodeFunctionCatalogRepository = fakeCodeFunctionCatalog(),
) {
	return new ApplicationWorkflowDataService({
		workflowDefinitions: makeService({}).workflowDefinitions,
		workflowTriggers: fakeWorkflowTriggers(),
		userProfiles: fakeUserProfiles(),
		settings: fakeSettings(),
		mcpConnections,
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections,
		adminPieces: fakeAdminPieces(),
		apiKeys: fakeApiKeys(),
		workspaceProjects: fakeWorkspaceProjects(),
		pieceCatalog,
		codeFunctionCatalog,
		benchmarkBrowser: fakeBenchmarkBrowser(),
		workflowExecutions: {} as WorkflowExecutionRepository,
		sessionEventNotifications: fakeSessionEventNotifications(),
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
	});
}

function makeServiceWithHostedMcp(
	hostedMcpServers: HostedMcpServerRepository,
	workspaceProjects: WorkspaceProjectRepository = {
		...fakeWorkspaceProjects(),
		getProjectMembershipDetail: vi.fn(async () => ({
			id: "project-1",
			displayName: "Project",
			externalId: "workspace-1",
			selfRole: "ADMIN" as const,
		})),
	},
) {
	return new ApplicationWorkflowDataService({
		workflowDefinitions: makeService({}).workflowDefinitions,
		workflowTriggers: fakeWorkflowTriggers(),
		userProfiles: fakeUserProfiles(),
		settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers,
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
		adminPieces: fakeAdminPieces(),
		apiKeys: fakeApiKeys(),
		workspaceProjects,
		pieceCatalog: fakePieceCatalog(),
		benchmarkBrowser: fakeBenchmarkBrowser(),
		workflowExecutions: {} as WorkflowExecutionRepository,
		sessionEventNotifications: fakeSessionEventNotifications(),
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
	});
}

function makeServiceWithWorkspaceProjects(
  workspaceProjects: WorkspaceProjectRepository,
) {
	return new ApplicationWorkflowDataService({
		workflowDefinitions: makeService({}).workflowDefinitions,
		workflowTriggers: fakeWorkflowTriggers(),
		userProfiles: fakeUserProfiles(),
		settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
		adminPieces: fakeAdminPieces(),
		apiKeys: fakeApiKeys(),
		workspaceProjects,
		pieceCatalog: fakePieceCatalog(),
		benchmarkBrowser: fakeBenchmarkBrowser(),
		workflowExecutions: {} as WorkflowExecutionRepository,
		sessionEventNotifications: fakeSessionEventNotifications(),
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
	});
}

function makeServiceWithUsageReporting(
  usageReporting: UsageReportingRepository,
) {
	return new ApplicationWorkflowDataService({
		workflowDefinitions: makeService({}).workflowDefinitions,
		workflowTriggers: fakeWorkflowTriggers(),
		userProfiles: fakeUserProfiles(),
		settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
		adminPieces: fakeAdminPieces(),
		apiKeys: fakeApiKeys(),
		workspaceProjects: fakeWorkspaceProjects(),
		pieceCatalog: fakePieceCatalog(),
		benchmarkBrowser: fakeBenchmarkBrowser(),
		workflowExecutions: {} as WorkflowExecutionRepository,
		sessionEventNotifications: fakeSessionEventNotifications(),
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
		usageReporting,
	});
}

function makeServiceWithSandboxInventory(
	sandboxInventory: SandboxInventoryRepository,
	sandboxRuntimeInventory: SandboxRuntimeInventory = fakeSandboxRuntimeInventory(),
) {
	return new ApplicationWorkflowDataService({
		workflowDefinitions: makeService({}).workflowDefinitions,
		workflowTriggers: fakeWorkflowTriggers(),
		userProfiles: fakeUserProfiles(),
		settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
		adminPieces: fakeAdminPieces(),
		apiKeys: fakeApiKeys(),
		workspaceProjects: fakeWorkspaceProjects(),
		pieceCatalog: fakePieceCatalog(),
		benchmarkBrowser: fakeBenchmarkBrowser(),
		workflowExecutions: {} as WorkflowExecutionRepository,
		sessionEventNotifications: fakeSessionEventNotifications(),
		artifactStore: {} as ArtifactStore,
		workspaceSessions: {} as WorkspaceSessionStore,
		agentRuns: {} as WorkflowAgentRunStore,
		planArtifacts: {} as WorkflowPlanArtifactStore,
		traceLineage: {} as TraceLineageStore,
		sandboxInventory,
		sandboxRuntimeInventory,
	});
}

describe("ApplicationWorkflowDataService", () => {
	it("builds the home page read model through application ports", async () => {
		const userProfiles: UserProfileRepository = {
			getUserProfile: vi.fn(async () => ({
				name: "Ada Lovelace",
				email: "ada@example.com",
				image: null,
				platformRole: "MEMBER" as const,
			})),
		};
		const homePageReads: HomePageReadRepository = {
			listRecentHomeSessions: vi.fn(async () => [
				{
					id: "session-1",
					title: "Recent session",
					status: "running",
					agentId: "agent-1",
					updatedAt: new Date("2026-01-02T00:00:00.000Z"),
				},
			]),
			listRecentHomeRuns: vi.fn(async () => [
				{
					executionId: "exec-1",
					workflowId: "wf-1",
					workflowName: "Workflow",
					status: "success",
					startedAt: new Date("2026-01-01T00:00:00.000Z"),
					duration: "1234",
				},
			]),
		};
		const { service } = makeService({ userProfiles, homePageReads });

		await expect(
			service.getHomePageReadModel({
				userId: "user-1",
				projectId: "project-1",
				limit: 5,
			}),
		).resolves.toEqual({
			user: {
				name: "Ada Lovelace",
				email: "ada@example.com",
			},
			recentSessions: [
				{
					id: "session-1",
					title: "Recent session",
					status: "running",
					agentId: "agent-1",
					updatedAt: "2026-01-02T00:00:00.000Z",
				},
			],
			recentRuns: [
				{
					executionId: "exec-1",
					workflowId: "wf-1",
					workflowName: "Workflow",
					status: "success",
					startedAt: "2026-01-01T00:00:00.000Z",
					durationMs: 1234,
				},
			],
		});
		expect(homePageReads.listRecentHomeSessions).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			limit: 5,
		});
		expect(homePageReads.listRecentHomeRuns).toHaveBeenCalledWith({
			projectId: "project-1",
			limit: 5,
		});
	});

	it("omits home page runs when there is no project scope", async () => {
		const homePageReads = fakeHomePageReads();
		const { service } = makeService({ homePageReads });

		await service.getHomePageReadModel({
			userId: "user-1",
			projectId: null,
			limit: 5,
		});

		expect(homePageReads.listRecentHomeSessions).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: null,
			limit: 5,
		});
		expect(homePageReads.listRecentHomeRuns).not.toHaveBeenCalled();
	});

	it("keeps home page recents best-effort", async () => {
		const userProfiles: UserProfileRepository = {
			getUserProfile: vi.fn(async () => {
				throw new Error("profile unavailable");
			}),
		};
		const homePageReads: HomePageReadRepository = {
			listRecentHomeSessions: vi.fn(async () => {
				throw new Error("sessions unavailable");
			}),
			listRecentHomeRuns: vi.fn(async () => {
				throw new Error("runs unavailable");
			}),
		};
		const { service } = makeService({ userProfiles, homePageReads });

		await expect(
			service.getHomePageReadModel({
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			user: null,
			recentSessions: [],
			recentRuns: [],
		});
	});

	it("resolves auto workflow refs by id before name", async () => {
		const { service, workflowDefinitions } = makeService({
			byId: baseWorkflow,
			byName: { ...baseWorkflow, id: "wf-name" },
		});

		await expect(
			service.getWorkflowByRef({
				workflowId: "wf-id",
				workflowName: "example",
				lookup: "auto",
			}),
		).resolves.toEqual(baseWorkflow);

		expect(workflowDefinitions.getById).toHaveBeenCalledWith("wf-id");
		expect(workflowDefinitions.getLatestByName).not.toHaveBeenCalled();
	});

	it("falls back to workflow name when auto id lookup misses", async () => {
		const namedWorkflow = { ...baseWorkflow, id: "wf-name" };
		const { service, workflowDefinitions } = makeService({
			byId: null,
			byName: namedWorkflow,
		});

		await expect(
			service.getWorkflowByRef({
				workflowId: "missing-id",
				workflowName: "example",
				lookup: "auto",
			}),
		).resolves.toEqual(namedWorkflow);

		expect(workflowDefinitions.getById).toHaveBeenCalledWith("missing-id");
		expect(workflowDefinitions.getLatestByName).toHaveBeenCalledWith("example");
	});

	it("loads a workflow only when it is visible in the caller's active project", async () => {
    const { service, workflowDefinitions } = makeService({
      byId: baseWorkflow,
    });

		await expect(
			service.getScopedWorkflowById({
				workflowId: "wf-id",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(baseWorkflow);
		expect(workflowDefinitions.getById).toHaveBeenCalledWith("wf-id");
	});

	it("hides workflows from a different active project", async () => {
		const { service } = makeService({ byId: baseWorkflow });

		await expect(
			service.getScopedWorkflowById({
				workflowId: "wf-id",
				userId: "user-1",
				projectId: "project-2",
			}),
		).resolves.toBeNull();
	});

  it("resolves same-name workflows inside the caller's active project", async () => {
    const { service, workflowDefinitions } = makeService({
      byName: baseWorkflow,
    });

    await expect(
      service.getScopedWorkflowByName({
        workflowName: " example ",
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual(baseWorkflow);
    expect(workflowDefinitions.getLatestByNameInProject).toHaveBeenCalledWith(
      "example",
      "project-1",
    );
  });

	it("delegates workflow definition commands to the workflow definition port", async () => {
		const { service, workflowDefinitions } = makeService({
			byId: baseWorkflow,
		});

		await service.listWorkflows({ limit: 50, projectId: "project-1" });
		await service.findProjectWorkflowIdByIdOrNamePrefix({
			projectId: "project-1",
			workflowId: "preview-ui-development-gan",
			namePrefix: "Preview UI development GAN%",
		});
		await service.createWorkflowDefinition({
			name: "New workflow",
			nodes: [],
			edges: [],
			engineType: "dapr",
			userId: "user-1",
			projectId: "project-1",
		});
		await service.updateWorkflowDefinition("wf-id", {
			name: "Updated",
			nodes: [],
			edges: [],
		});
		await service.hasActiveWorkflowExecutions("wf-id");
		await service.deleteWorkflowDefinition("wf-id");

		expect(workflowDefinitions.list).toHaveBeenCalledWith({
			limit: 50,
			projectId: "project-1",
		});
    expect(
      workflowDefinitions.findProjectWorkflowIdByIdOrNamePrefix,
    ).toHaveBeenCalledWith({
			projectId: "project-1",
			workflowId: "preview-ui-development-gan",
			namePrefix: "Preview UI development GAN%",
		});
		expect(workflowDefinitions.create).toHaveBeenCalledWith(
			expect.objectContaining({ name: "New workflow", engineType: "dapr" }),
		);
		expect(workflowDefinitions.update).toHaveBeenCalledWith("wf-id", {
			name: "Updated",
			nodes: [],
			edges: [],
		});
    expect(workflowDefinitions.hasActiveExecutions).toHaveBeenCalledWith(
      "wf-id",
    );
		expect(workflowDefinitions.delete).toHaveBeenCalledWith("wf-id");
	});

	it("delegates public trigger webhook reads and fired stamps to trigger ports", async () => {
		const { service, workflowTriggers } = makeService({ byId: baseWorkflow });
		const trigger = {
			id: "trigger-1",
			workflowId: "wf-id",
			userId: "user-1",
			projectId: "project-1",
			kind: "github",
			config: { events: "push" },
			triggerData: { source: "github" },
			dedupSalt: "salt",
			backingRef: null,
			status: "active" as const,
			lastError: null,
			lastFiredAt: null,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		vi.mocked(workflowTriggers.getById).mockResolvedValueOnce(trigger);

    await expect(service.getWorkflowTriggerById("trigger-1")).resolves.toEqual(
      trigger,
    );
		const firedAt = new Date("2026-02-01T00:00:00.000Z");
		await service.markWorkflowTriggerFired({ triggerId: "trigger-1", firedAt });

		expect(workflowTriggers.getById).toHaveBeenCalledWith("trigger-1");
		expect(workflowTriggers.markFired).toHaveBeenCalledWith({
			triggerId: "trigger-1",
			firedAt,
		});
	});

	it("delegates triggered-run admission counts to execution ports", async () => {
		const workflowExecutions = {
			countActiveTriggeredRuns: vi.fn(async () => 7),
		};
		const { service } = makeService({ workflowExecutions });

		await expect(
      service.countActiveTriggeredWorkflowRuns({
        statuses: ["pending", "running"],
      }),
		).resolves.toBe(7);
		expect(workflowExecutions.countActiveTriggeredRuns).toHaveBeenCalledWith({
			statuses: ["pending", "running"],
		});
	});

	it("returns scoped execution records through the execution port", async () => {
		const execution = workflowExecutionRecord({
			id: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
		const workflowExecutions = {
			getById: vi.fn(async () => execution),
		};
		const { service } = makeService({ workflowExecutions });

		await expect(
			service.getScopedExecutionById({
				executionId: "exec-1",
				userId: "user-2",
				projectId: "project-1",
			}),
		).resolves.toEqual(execution);
		expect(workflowExecutions.getById).toHaveBeenCalledWith("exec-1");
	});

	it("hides scoped execution records outside the caller project", async () => {
		const workflowExecutions = {
			getById: vi.fn(async () =>
				workflowExecutionRecord({
					id: "exec-1",
					userId: "user-1",
					projectId: "project-2",
				}),
			),
		};
		const { service } = makeService({ workflowExecutions });

		await expect(
			service.getScopedExecutionById({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toBeNull();
	});

	it("preserves legacy owner fallback for unscoped execution records", async () => {
		const workflowExecutions = {
			getById: vi.fn(async () =>
				workflowExecutionRecord({
					id: "exec-1",
					userId: "user-1",
					projectId: null,
				}),
			),
		};
		const { service } = makeService({ workflowExecutions });

		await expect(
			service.getScopedExecutionById({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-2",
			}),
		).resolves.toEqual(expect.objectContaining({ id: "exec-1" }));
		await expect(
			service.getScopedExecutionById({
				executionId: "exec-1",
				userId: "user-2",
				projectId: "project-2",
			}),
		).resolves.toBeNull();
	});

	it("delegates piece execution artifact reads to the piece execution port", async () => {
		const pieceExecution = {
			idempotencyKey: "wf:exec:task",
			status: "completed" as const,
			result: { ok: true },
			error: null,
			pieceName: "@activepieces/piece-github",
			actionName: "create_issue",
			completedAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const pieceExecutions = {
			getByIdempotencyKey: vi.fn(async () => pieceExecution),
		} satisfies PieceExecutionRepository;
		const { service } = makeService({ byId: baseWorkflow, pieceExecutions });

    await expect(
      service.getPieceExecutionByIdempotencyKey("wf:exec:task"),
    ).resolves.toEqual(pieceExecution);
    expect(pieceExecutions.getByIdempotencyKey).toHaveBeenCalledWith(
      "wf:exec:task",
		);
	});

	it("ingests session events through session and checkpoint ports", async () => {
		const sessions = fakeSessions();
		const sessionEvents = fakeSessionEvents();
		const codeCheckpoints = fakeCodeCheckpoints();
		const evaluationArtifacts = fakeEvaluationArtifacts();
		const { service } = makeService({
			sessions,
			sessionEvents,
			codeCheckpoints,
			evaluationArtifacts,
		});

		const result = await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_terminated",
			data: {
				stop_reason: { type: "terminated", event_ids: ["event-a"] },
				toolName: "edit_file",
				codeCheckpoint: {
					status: "created",
					remoteStatus: "error",
					remoteError: "push failed",
					remoteRef: "refs/heads/checkpoint",
					changedFiles: [{ path: "src/app.ts" }],
				},
			},
			sourceEventId: "agent-event-1",
			producerId: "runtime-1",
			producerEpoch: "epoch-1",
		});

		expect(result.cleanupSessionSandbox).toBe(true);
		expect(result.event.id).toBe("event-1");
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "session.status_terminated",
			data: expect.objectContaining({ toolName: "edit_file" }),
			processedAt: undefined,
			sourceEventId: "agent-event-1",
			producerId: "runtime-1",
			producerEpoch: "epoch-1",
		});
		expect(sessions.updateSessionStatus).toHaveBeenCalledWith({
			id: "session-1",
			status: "terminated",
			stopReason: { type: "terminated", event_ids: ["event-a"] },
			markCompleted: true,
		});
    expect(sessions.getSessionWorkflowContext).toHaveBeenCalledWith(
      "session-1",
    );
		expect(codeCheckpoints.persistFromAgentEvent).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowExecutionId: "exec-1",
				parentExecutionId: "parent-exec-1",
				daprInstanceId: "dapr-session-1",
				sourceEventId: "agent-event-1",
				toolName: "edit_file",
				payload: expect.objectContaining({ remoteError: "push failed" }),
			}),
		);
    expect(
      evaluationArtifacts.recordCodeCheckpointWarning,
    ).toHaveBeenCalledWith({
			workflowExecutionId: "exec-1",
			sourceEventId: "agent-event-1",
			checkpoint: {
				remoteStatus: "error",
				remoteError: "push failed",
				remoteRef: "refs/heads/checkpoint",
				toolCallId: null,
				toolName: null,
			},
		});
	});

	it("marks a session failed on session.status_errored and extracts the error message", async () => {
		const sessions = fakeSessions();
		const sessionEvents = fakeSessionEvents();
    const { service } = makeService({
      sessions,
      sessionEvents,
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_errored",
			data: {
				stop_reason: { type: "error", message: "turn aborted: exit 137" },
				reason: "turn_failed",
			},
			sourceEventId: "agent-event-err",
		});

		// Routed through the terminated-guarded update (never updateSessionStatus /
		// markCompleted), so an already-`terminated` row stays sticky and no
		// completedAt is stamped — the pod may still be alive (interactive TUI).
		expect(sessions.updateSessionStatus).not.toHaveBeenCalled();
		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "session-1",
				status: "failed",
				errorMessage: "turn aborted: exit 137",
			}),
		);
		// `error` is on the whitelist → PRESERVED (not coerced to end_turn), so the
		// failed row's stopReason stays distinct and no consumer of the normalized
		// value (e.g. the goal loop) mistakes a failed turn for a normal end_turn.
		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith(
			expect.objectContaining({ stopReason: { type: "error" } }),
		);
	});

	it("falls back to data.reason then data.message for the errored errorMessage", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_errored",
			data: { reason: "sync_timeout" },
		});
		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorMessage: "sync_timeout",
      }),
		);

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_errored",
			data: { message: "no stop_reason or reason" },
		});
    expect(
      sessions.updateSessionStatusUnlessTerminated,
    ).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: "failed",
				errorMessage: "no stop_reason or reason",
			}),
		);
	});

	it("preserves a crashed stop reason through normalization (whitelist)", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_errored",
			data: { stop_reason: { type: "crashed", message: "pod deleted" } },
		});

		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				stopReason: { type: "crashed" },
				errorMessage: "pod deleted",
			}),
		);
	});

	it("keeps an error stop reason on a status_idle (interactive turn.failed)", async () => {
		// The interactive turn.failed edge publishes status_idle{stop_reason:error}.
		// `error` must survive normalization (NOT coerce to end_turn) so the row's
		// stopReason stays distinct and the goal loop does not auto-continue.
		const sessions = fakeSessions();
		const { service } = makeService({
			sessions,
			sessionEvents: fakeSessionEvents(),
		});

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_idle",
			data: { stop_reason: { type: "error" } },
		});

		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith({
			id: "session-1",
			status: "idle",
			stopReason: { type: "error" },
		});
	});

	it("re-activates a failed session on the next session.status_running event", async () => {
		// `failed` is NON-terminal: a later status_running must legitimately flip
		// it back to running (only `terminated` sticks). The service routes both
		// through updateSessionStatusUnlessTerminated so the DB guard allows it.
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_running",
			data: {},
		});

		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith({
			id: "session-1",
			status: "running",
		});
		expect(sessions.updateSessionStatus).not.toHaveBeenCalled();
	});

	it("routes session.status_rescheduled through the running-guarded updater", async () => {
		// The runtime emits status_rescheduled at session entry ~250ms before
		// status_running, and NATS ingestion can deliver them out of order. The
		// rescheduled projection must use updateSessionStatusRescheduled (which
		// adds status <> 'running' to the WHERE clause) so a late rescheduled
		// event can never flip an already-running row back to rescheduling and
		// wedge the UI at "Waiting for admission" for the session's lifetime.
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_running",
			data: {},
		});
		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_rescheduled",
			data: {},
		});

		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith({
			id: "session-1",
			status: "running",
		});
		expect(sessions.updateSessionStatusRescheduled).toHaveBeenCalledWith({
			id: "session-1",
			status: "rescheduling",
		});
		// The plain updater is not used for the rescheduled path.
		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledTimes(
			1,
		);
	});

	it("bumps last_event_at for every ingested event, including heartbeats", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		// A heartbeat carries no status transition, but must still refresh the
		// liveness stamp so the reconciler can tell quiet-but-alive from dead.
		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.turn_heartbeat",
			data: {},
		});
		expect(sessions.bumpSessionLastEventAt).toHaveBeenCalledWith("session-1");
		expect(sessions.updateSessionStatus).not.toHaveBeenCalled();
		expect(sessions.updateSessionStatusUnlessTerminated).not.toHaveBeenCalled();

		// It also fires alongside a real status transition.
		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_running",
			data: {},
		});
		expect(sessions.bumpSessionLastEventAt).toHaveBeenCalledTimes(2);
	});

	it("SETs pending_input on a blocked idle with the kind derived from the reason", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_idle",
			data: { blocked: true, reason: "permission_prompt" },
		});
		expect(sessions.setSessionPendingInput).toHaveBeenCalledWith("session-1", {
			kind: "permission",
			prompt: "permission_prompt",
			eventId: "event-1",
			since: "2026-01-01T00:00:00.000Z",
		});

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_idle",
			data: { blocked: true, reason: "awaiting_input" },
		});
		expect(sessions.setSessionPendingInput).toHaveBeenLastCalledWith(
			"session-1",
			expect.objectContaining({ kind: "question", prompt: "awaiting_input" }),
		);

		// An auth block (or any unrecognized reason) is a generic "blocked" kind.
		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_idle",
			data: { blocked: true, reason: "auth" },
		});
		expect(sessions.setSessionPendingInput).toHaveBeenLastCalledWith(
			"session-1",
			expect.objectContaining({ kind: "blocked", prompt: "auth" }),
		);
	});

	it("SETs pending_input on a permission request (hook.decision ask) + ADK confirmation", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "hook.decision",
			data: { decision: "ask", tool_name: "Bash", tool_use_id: "tool-9" },
		});
		expect(sessions.setSessionPendingInput).toHaveBeenLastCalledWith(
			"session-1",
			expect.objectContaining({
				kind: "permission",
				toolUseId: "tool-9",
				prompt: "Bash",
			}),
		);

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "adk.tool_confirmation_request",
      data: {
        requested_tool_confirmations: { "call-42": { toolName: "delete" } },
      },
		});
		expect(sessions.setSessionPendingInput).toHaveBeenLastCalledWith(
			"session-1",
			expect.objectContaining({ kind: "permission", toolUseId: "call-42" }),
		);
	});

	it("does NOT set pending_input on a non-'ask' hook.decision", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "hook.decision",
			data: { decision: "allow", tool_name: "Read" },
		});
		expect(sessions.setSessionPendingInput).not.toHaveBeenCalled();
	});

	it("CLEARs pending_input on running / terminated / errored and on user answers", async () => {
		for (const event of [
			{ type: "session.status_running", data: {} },
			{ type: "session.status_terminated", data: {} },
			{ type: "session.status_errored", data: {} },
      {
        type: "user.message",
        data: { content: [{ type: "text", text: "yes" }] },
      },
      {
        type: "user.tool_confirmation",
        data: { tool_use_id: "t1", result: "allow" },
      },
			{ type: "user.custom_tool_result", data: { tool_use_id: "t1" } },
			{ type: "user.interrupt", data: {} },
		]) {
			const sessions = fakeSessions();
      const { service } = makeService({
        sessions,
        sessionEvents: fakeSessionEvents(),
      });
			await service.ingestSessionEvent({ sessionId: "session-1", ...event });
      expect(sessions.setSessionPendingInput).toHaveBeenCalledWith(
        "session-1",
        null,
      );
		}
	});

	it("CLEARs pending_input on a normal end_turn idle and does NOT set it", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "session.status_idle",
			data: { stop_reason: { type: "end_turn" } },
		});
		// A normal turn-completion idle isn't a block → the cache is CLEARed (null),
		// never SET to a PendingInput value.
    expect(sessions.setSessionPendingInput).toHaveBeenCalledWith(
      "session-1",
      null,
    );
		expect(sessions.setSessionPendingInput).not.toHaveBeenCalledWith(
			"session-1",
			expect.objectContaining({ kind: expect.anything() }),
		);
	});

	it("leaves pending_input untouched for irrelevant events (heartbeat, tool_use)", async () => {
		const sessions = fakeSessions();
    const { service } = makeService({
      sessions,
      sessionEvents: fakeSessionEvents(),
    });

		await service.ingestSessionEvent({
			sessionId: "session-1",
			type: "agent.tool_use",
			data: { tool_name: "Read" },
		});
		expect(sessions.setSessionPendingInput).not.toHaveBeenCalled();
	});

	it("resolves interactive CLI workspace command candidates through session ports", async () => {
		const sessions = {
			...fakeSessions(),
			listCliWorkspaceSessionCandidates: vi.fn(async () => [
				{
					id: "session-codex",
					userId: "user-1",
					projectId: "project-1",
					runtimeAppId: "agent-session-codex",
					runtimeSandboxName: "agent-host-agent-session-codex",
					agentSlug: "codex",
					agentRuntime: "codex-cli",
					agentRuntimeAppId: null,
				},
				{
					id: "session-durable",
					userId: "user-1",
					projectId: "project-1",
					runtimeAppId: "agent-session-durable",
					runtimeSandboxName: "agent-host-agent-session-durable",
					agentSlug: "durable",
					agentRuntime: "dapr-agent-py",
					agentRuntimeAppId: null,
				},
			]),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
      service.listCliWorkspaceCommandCandidates({
        executionId: "exec-1",
        limit: 8,
      }),
		).resolves.toEqual([
			{
				sessionId: "session-codex",
				userId: "user-1",
				projectId: "project-1",
				appId: "agent-session-codex",
				invokeTarget: "agent-session-codex",
				runtimeSandboxName: "agent-host-agent-session-codex",
				source: "persisted",
				agentSlug: "codex",
				agentRuntime: "codex-cli",
			},
		]);
		expect(sessions.listCliWorkspaceSessionCandidates).toHaveBeenCalledWith({
			executionId: "exec-1",
			limit: 8,
		});
	});

	it("detects interactive CLI executions through session runtime ports", async () => {
		const sessions = {
			...fakeSessions(),
			listWorkflowExecutionSessionRuntimes: vi.fn(async () => [
				{ sessionId: "session-durable", agentRuntime: "dapr-agent-py" },
				{ sessionId: "session-codex", agentRuntime: "codex-cli" },
			]),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.hasInteractiveCliSessionForExecution("exec-1"),
		).resolves.toBe(true);
		expect(sessions.listWorkflowExecutionSessionRuntimes).toHaveBeenCalledWith({
			workflowExecutionId: "exec-1",
		});

    vi.mocked(
      sessions.listWorkflowExecutionSessionRuntimes,
    ).mockResolvedValueOnce([
			{ sessionId: "session-durable", agentRuntime: "dapr-agent-py" },
		]);
		await expect(
			service.hasInteractiveCliSessionForExecution("exec-2"),
		).resolves.toBe(false);
	});

	it("delegates workflow ensure session persistence to the session port", async () => {
		const sessions = fakeSessions();
		const { service } = makeService({ sessions });

		await expect(
			service.getWorkflowEnsureSession("session-1"),
		).resolves.toMatchObject({
			id: "session-1",
			agentId: "agent-1",
			workflowExecutionId: "exec-1",
		});
		await service.createWorkflowEnsureSession({
			id: "session-2",
			title: "Workflow run",
			agentId: "agent-2",
			agentVersion: 7,
			vaultIds: ["vault-1"],
			userId: "user-1",
			projectId: "project-1",
			sandboxName: "dapr-agent-py",
			workflowExecutionId: "exec-1",
			parentExecutionId: "parent-1",
		});
		await service.updateWorkflowEnsureSessionRuntime({
			sessionId: "session-2",
			expectedStartedAt: new Date("2026-07-21T12:00:00.000Z"),
			runtimeAppId: "agent-session-2",
			runtimeSandboxName: "agent-host-agent-session-2",
		});

		expect(sessions.getWorkflowEnsureSession).toHaveBeenCalledWith("session-1");
		expect(sessions.createWorkflowEnsureSession).toHaveBeenCalledWith({
			id: "session-2",
			title: "Workflow run",
			agentId: "agent-2",
			agentVersion: 7,
			vaultIds: ["vault-1"],
			userId: "user-1",
			projectId: "project-1",
			sandboxName: "dapr-agent-py",
			workflowExecutionId: "exec-1",
			parentExecutionId: "parent-1",
		});
		expect(sessions.updateWorkflowEnsureSessionRuntime).toHaveBeenCalledWith({
			sessionId: "session-2",
				expectedStartedAt: new Date("2026-07-21T12:00:00.000Z"),
			runtimeAppId: "agent-session-2",
			runtimeSandboxName: "agent-host-agent-session-2",
		});
	});

	it("lists terminal workflow session runtime hosts through the session port", async () => {
		const sessions = fakeSessions();
		const { service } = makeService({ sessions });

		await expect(
			service.listReapableWorkflowSessionRuntimeHosts({
				workflowExecutionId: "exec-1",
			}),
		).resolves.toEqual([
			{ sessionId: "session-old", runtimeAppId: "agent-session-old" },
		]);
    expect(
      sessions.listReapableWorkflowSessionRuntimeHosts,
    ).toHaveBeenCalledWith({
			workflowExecutionId: "exec-1",
		});
	});

	it("checks benchmark provisioning gate through the benchmark run port", async () => {
		const benchmarkRuns = fakeBenchmarkRuns();
		const { service } = makeService({ benchmarkRuns });

		await expect(
			service.checkBenchmarkSessionProvisioningGate({
				runId: "bench-1",
				instanceId: "inst-1",
			}),
		).resolves.toEqual({
			ok: true,
			benchmarkExecutionClass: "gpu-large",
		});
		expect(benchmarkRuns.getSessionProvisioningGate).toHaveBeenCalledWith({
			runId: "bench-1",
			instanceId: "inst-1",
		});
	});

	it("preserves benchmark provisioning gate failure semantics", async () => {
		const missingRuns = {
			getProjectId: vi.fn(async () => null),
			getSessionProvisioningGate: vi.fn(async () => null),
		} satisfies BenchmarkRunRepository;
		await expect(
      makeService({
        benchmarkRuns: missingRuns,
      }).service.checkBenchmarkSessionProvisioningGate({
				runId: "bench-missing",
				instanceId: "inst-1",
			}),
		).resolves.toEqual({
			ok: false,
			status: 404,
			message: "Benchmark run not found",
		});

		for (const [field, value, message] of [
			[
				"runStatus",
				"completed",
				"Benchmark run bench-1 is completed; refusing to provision session host",
			],
			[
				"instanceStatus",
				"resolved",
				"Benchmark instance inst-1 is resolved; refusing to provision session host",
			],
			[
				"inferenceStatus",
				"inferred",
				"Benchmark instance inst-1 inference is inferred; refusing to provision session host",
			],
		] as const) {
			const benchmarkRuns = {
				getProjectId: vi.fn(async () => "project-1"),
				getSessionProvisioningGate: vi.fn(async () => ({
					runStatus: "inferencing",
					summary: {},
					instanceStatus: "queued",
					inferenceStatus: "inferencing",
					[field]: value,
				})),
			} satisfies BenchmarkRunRepository;
			await expect(
				makeService({
					benchmarkRuns,
				}).service.checkBenchmarkSessionProvisioningGate({
					runId: "bench-1",
					instanceId: "inst-1",
				}),
			).resolves.toEqual({
				ok: false,
				status: 409,
				message,
			});
		}
	});

	it("returns no benchmark execution class for malformed summaries", async () => {
		const benchmarkRuns = {
			getProjectId: vi.fn(async () => "project-1"),
			getSessionProvisioningGate: vi.fn(async () => ({
				runStatus: "queued",
				summary: { execution: { class: " " } },
				instanceStatus: null,
				inferenceStatus: null,
			})),
		} satisfies BenchmarkRunRepository;
		const { service } = makeService({ benchmarkRuns });

		await expect(
			service.checkBenchmarkSessionProvisioningGate({
				runId: "bench-1",
			}),
		).resolves.toEqual({
			ok: true,
			benchmarkExecutionClass: null,
		});
	});

	it("resolves workflow agent runtime identity through the agent read port", async () => {
		const workflowAgentReads = fakeWorkflowAgentReads();
		const { service } = makeService({ workflowAgentReads });

		await expect(
			service.getWorkflowAgentRuntimeIdentity("agent-1"),
		).resolves.toEqual({
			agentId: "agent-1",
			slug: "test-agent",
			runtimeAppId: "agent-runtime-test-agent",
			appId: "agent-runtime-test-agent",
		});
    expect(
      workflowAgentReads.getWorkflowAgentRuntimeIdentity,
    ).toHaveBeenCalledWith("agent-1");
	});

	it("resolves published workflow agents through the agent read port", async () => {
		const workflowAgentReads = fakeWorkflowAgentReads();
		const { service } = makeService({ workflowAgentReads });

		await expect(
			service.resolvePublishedWorkflowAgentForEnsure({
				agentId: "agent-1",
				agentVersion: 4,
				projectId: "project-1",
			}),
		).resolves.toEqual({
			ok: true,
			agent: {
				agentId: "agent-1",
				agentVersion: 4,
				agentSlug: "published-agent",
				agentAppId: "agent-runtime-published-agent",
				mlflowUri: "models:/published-agent/3",
				mlflowModelName: "published-agent",
				mlflowModelVersion: "model-3",
			},
		});
		expect(
			workflowAgentReads.resolvePublishedWorkflowAgentForEnsure,
		).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 4,
			projectId: "project-1",
		});
	});

	it("ensures peer sessions through session and peer-agent ports", async () => {
		const sessions = fakeSessions();
		const sessionEvents = fakeSessionEvents();
		const peerAgentResolver = fakePeerAgentResolver();
		const { service } = makeService({
			sessions,
			sessionEvents,
			peerAgentResolver,
		});

		const result = await service.ensurePeerSession({
			sessionId: "ca-session-1",
			peerAgentId: "agent-peer",
			peerAgentVersion: 3,
			prompt: "Review this change",
			workflowExecutionId: "exec-1",
			parentSessionId: "parent-session-1",
			parentInstanceId: "parent-instance-1",
			title: null,
		});

		expect(result).toEqual({
			ok: true,
			reused: false,
			session: {
				id: "ca-session-1",
				status: "rescheduling",
				agentId: "agent-peer",
				agentVersion: 3,
				environmentId: "env-1",
				environmentVersion: 4,
				vaultIds: ["vault-1"],
				daprInstanceId: null,
				natsSubject: null,
				runtimeAppId: null,
				runtimeProvisioningStartedAt: null,
				workflowExecutionId: "exec-1",
        parentExecutionId: "parent-instance-1",
				stopRequestedAt: null,
				completedAt: null,
			},
		});
    expect(sessions.getSessionFileOwner).toHaveBeenCalledWith(
      "parent-session-1",
    );
		expect(peerAgentResolver.resolvePeerAgentOwner).not.toHaveBeenCalled();
		expect(sessions.createPeerSession).toHaveBeenCalledWith({
			id: "ca-session-1",
			agentId: "agent-peer",
			agentVersion: 3,
			title: "Delegated: Review this change",
			userId: "user-1",
			projectId: "project-1",
			workflowExecutionId: "exec-1",
			parentExecutionId: "parent-instance-1",
		});
    expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith(
      "ca-session-1",
      {
			type: "user.message",
			data: {
				type: "user.message",
				content: [{ type: "text", text: "Review this change" }],
			},
			processedAt: null,
      },
    );
	});

	it("returns reused peer sessions without appending another prompt", async () => {
		const existingSession = {
			id: "ca-existing",
			status: "running" as const,
			agentId: "agent-peer",
			agentVersion: 2,
			environmentId: null,
			environmentVersion: null,
			vaultIds: [],
			daprInstanceId: "ca-existing",
			natsSubject: "session.events.ca-existing",
			runtimeAppId: "agent-runtime-agent-peer",
			runtimeProvisioningStartedAt: null,
			workflowExecutionId: null,
      parentExecutionId: null,
			stopRequestedAt: null,
			completedAt: null,
		};
		const sessions = {
			...fakeSessions(),
			getPeerSession: vi.fn(async () => existingSession),
			createPeerSession: vi.fn(),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const { service } = makeService({
			sessions,
			sessionEvents,
			peerAgentResolver: fakePeerAgentResolver(),
		});

		await expect(
			service.ensurePeerSession({
				sessionId: "ca-existing",
				peerAgentId: "agent-peer",
				prompt: "again",
			}),
		).resolves.toEqual({ ok: true, session: existingSession, reused: true });
		expect(sessions.createPeerSession).not.toHaveBeenCalled();
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("rejects an existing peer whose version differs from the team pin", async () => {
		const existingSession = {
			id: "ca-existing-version",
			status: "running" as const,
			agentId: "agent-peer",
			agentVersion: 2,
			environmentId: null,
			environmentVersion: null,
			vaultIds: [],
			daprInstanceId: "ca-existing-version",
			natsSubject: "session.events.ca-existing-version",
			runtimeAppId: "agent-runtime-agent-peer",
			runtimeProvisioningStartedAt: null,
			workflowExecutionId: null,
			parentExecutionId: null,
			stopRequestedAt: null,
			completedAt: null,
		};
		const sessions = {
			...fakeSessions(),
			getPeerSession: vi.fn(async () => existingSession),
			createPeerSession: vi.fn(),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const { service } = makeService({
			sessions,
			sessionEvents,
			peerAgentResolver: fakePeerAgentResolver(),
		});

		await expect(
			service.ensurePeerSession({
				sessionId: existingSession.id,
				peerAgentId: "agent-peer",
				peerAgentVersion: 3,
				prompt: "again",
			}),
		).resolves.toEqual({
			ok: false,
			status: 409,
			message:
				"Existing peer session agent version 2 does not match required version 3",
		});
		expect(sessions.createPeerSession).not.toHaveBeenCalled();
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("treats a concurrent peer insert as a replay and does not duplicate the prompt", async () => {
		const sessions = fakeSessions();
		const concurrent = {
			id: "ca-concurrent",
			status: "rescheduling" as const,
			agentId: "agent-peer",
			agentVersion: 3,
			environmentId: null,
			environmentVersion: null,
			vaultIds: [],
			daprInstanceId: null,
			natsSubject: null,
			runtimeAppId: null,
			runtimeProvisioningStartedAt: null,
			workflowExecutionId: "exec-1",
			parentExecutionId: "parent-session-1",
			stopRequestedAt: null,
			completedAt: null,
		};
		vi.mocked(sessions.createPeerSession).mockResolvedValueOnce({
			status: "ok",
			session: concurrent,
			created: false,
		});
		const sessionEvents = fakeSessionEvents();
		const { service } = makeService({
			sessions,
			sessionEvents,
			peerAgentResolver: fakePeerAgentResolver(),
		});

		await expect(
			service.ensurePeerSession({
				sessionId: "ca-concurrent",
				peerAgentId: "agent-peer",
				prompt: "once",
				workflowExecutionId: "exec-1",
				parentSessionId: "parent-session-1",
			}),
		).resolves.toEqual({ ok: true, session: concurrent, reused: true });
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("rejects a concurrent peer insert that won with another agent version", async () => {
		const sessions = fakeSessions();
		vi.mocked(sessions.createPeerSession).mockResolvedValueOnce({
			status: "ok",
			created: false,
			session: {
				id: "ca-concurrent-version",
				status: "rescheduling",
				agentId: "agent-peer",
				agentVersion: 2,
				environmentId: null,
				environmentVersion: null,
				vaultIds: [],
				daprInstanceId: null,
				natsSubject: null,
				runtimeAppId: null,
				runtimeProvisioningStartedAt: null,
				workflowExecutionId: "exec-1",
				parentExecutionId: "parent-session-1",
				stopRequestedAt: null,
				completedAt: null,
			},
		});
		const sessionEvents = fakeSessionEvents();
		const { service } = makeService({
			sessions,
			sessionEvents,
			peerAgentResolver: fakePeerAgentResolver(),
		});

		await expect(
			service.ensurePeerSession({
				sessionId: "ca-concurrent-version",
				peerAgentId: "agent-peer",
				peerAgentVersion: 3,
				prompt: "once",
				workflowExecutionId: "exec-1",
				parentSessionId: "parent-session-1",
			}),
		).resolves.toEqual({
			ok: false,
			status: 409,
			message:
				"Peer session agent version 2 does not match required version 3",
		});
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("surfaces the parent execution fence as a conflict", async () => {
		const sessions = fakeSessions();
		vi.mocked(sessions.createPeerSession).mockResolvedValueOnce({
			status: "execution_not_active",
		});
		const sessionEvents = fakeSessionEvents();
		const { service } = makeService({
			sessions,
			sessionEvents,
			peerAgentResolver: fakePeerAgentResolver(),
		});

		await expect(
			service.ensurePeerSession({
				sessionId: "ca-stopped",
				peerAgentId: "agent-peer",
				prompt: "too late",
				workflowExecutionId: "exec-stopped",
				parentSessionId: "parent-session-1",
			}),
		).resolves.toEqual({
			ok: false,
			status: 409,
			message: "Parent session or workflow execution is stopping or terminal",
		});
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("falls back to peer ownership when no parent owner is available", async () => {
		const sessions = {
			...fakeSessions(),
			getSessionFileOwner: vi.fn(async () => null),
		} satisfies SessionRepository;
		const peerAgentResolver = fakePeerAgentResolver();
		const { service } = makeService({
			sessions,
			sessionEvents: fakeSessionEvents(),
			peerAgentResolver,
		});

		await service.ensurePeerSession({
			sessionId: "ca-session-2",
			peerAgentId: "agent-peer",
			prompt: "",
			parentSessionId: "missing-parent",
		});

    expect(peerAgentResolver.resolvePeerAgentOwner).toHaveBeenCalledWith(
      "agent-peer",
    );
		expect(sessions.createPeerSession).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "peer-owner-1",
				projectId: "peer-project-1",
			}),
		);
	});

	it("delegates peer dispatch context resolution to the peer-agent port", async () => {
		const peerAgentResolver = fakePeerAgentResolver();
		const { service } = makeService({ peerAgentResolver });

		await expect(
			service.resolvePeerAgentDispatchContext({
				agentId: "agent-peer",
				agentVersion: 3,
				environmentId: "env-1",
				environmentVersion: 4,
			}),
		).resolves.toEqual({
			agentConfig: expect.objectContaining({ systemPrompt: "You are a peer" }),
			environmentConfig: { image: "env-image" },
			callableAgents: [
				{
					slug: "reviewer",
					agentId: "agent-reviewer",
					version: 2,
					appId: "dapr-agent-py",
					team: "project-1",
					registryKey: "project-1/reviewer",
				},
			],
			registryTeam: "project-1",
		});
    expect(
      peerAgentResolver.resolvePeerAgentDispatchContext,
    ).toHaveBeenCalledWith({
			agentId: "agent-peer",
			agentVersion: 3,
			environmentId: "env-1",
			environmentVersion: 4,
		});
	});

	it("delegates browser artifact saves to the browser artifact store", async () => {
		const saved = {
			id: "bwf_1",
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "publish_shot",
			workspaceRef: null,
			artifactType: "capture_flow_v1" as const,
			artifactVersion: 1,
			status: "completed" as const,
			manifestJson: {},
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const browserArtifacts = {
			save: vi.fn(async () => saved),
			listByExecutionId: vi.fn(async () => []),
			getBlobPayload: vi.fn(async () => null),
		} satisfies WorkflowBrowserArtifactStore;
		const { service } = makeService({ browserArtifacts });
		const input = {
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "publish_shot",
			baseUrl: "",
			status: "completed" as const,
			steps: [],
			assets: [
				{
					kind: "video" as const,
					label: "Dashboard walkthrough",
					payloadBase64: "AAAA",
				},
			],
		};

    await expect(service.saveWorkflowBrowserArtifact(input)).resolves.toEqual(
      saved,
    );
		expect(browserArtifacts.save).toHaveBeenCalledWith(input);
	});

	it("delegates browser session target resolution through the session repository", async () => {
		const sessions = {
			...fakeSessions(),
			getBrowserSessionTarget: vi.fn(async () => ({
				sessionId: "session-1",
				agentSlug: "browser-agent",
			})),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.getSessionBrowserTarget({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			sessionId: "session-1",
			agentSlug: "browser-agent",
		});
		expect(sessions.getBrowserSessionTarget).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
	});

	it("loads provisioning state through session and provisioning ports", async () => {
		const sessions = {
			...fakeSessions(),
			getSessionProvisioningContext: vi.fn(async () => ({
				id: "session-1",
				status: "rescheduling" as const,
				runtimeAppId: "agent-session-1",
				projectId: "project-1",
			})),
		} satisfies SessionRepository;
		const sessionProvisioning = fakeSessionProvisioning();
		const { service } = makeService({ sessions, sessionProvisioning });

		await expect(
			service.getSessionProvisioningReadModel({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			data: expect.objectContaining({
				phase: "starting",
				podName: "agent-host-session-1",
			}),
		});
		expect(sessions.getSessionProvisioningContext).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
		expect(sessionProvisioning.getSessionProvisioning).toHaveBeenCalledWith({
			sessionId: "session-1",
			runtimeAppId: "agent-session-1",
		});
	});

	it("short-circuits provisioning for live or terminal sessions", async () => {
		const sessions = {
			...fakeSessions(),
			getSessionProvisioningContext: vi.fn(async () => ({
				id: "session-1",
				status: "terminated" as const,
				runtimeAppId: "agent-session-1",
				projectId: "project-1",
			})),
		} satisfies SessionRepository;
		const sessionProvisioning = fakeSessionProvisioning();
		const { service } = makeService({ sessions, sessionProvisioning });

		await expect(
			service.getSessionProvisioningReadModel({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			data: {
				phase: "running",
				label: "Ended",
				detail: null,
				podName: null,
				podPhase: null,
			},
		});
		expect(sessionProvisioning.getSessionProvisioning).not.toHaveBeenCalled();
	});

	it("delegates session context usage reads through the session repository", async () => {
		const usage = {
			sessionId: "session-1",
			usage: { input_tokens: 100 },
			activeContext: { context_used_percentage: 10 },
			lastProviderContext: { model: "openai/gpt-5.5" },
			events: { total: 3, totalBytes: 1024, llmTurns: 1 },
		};
		const sessions = {
			...fakeSessions(),
			getSessionContextUsage: vi.fn(async () => usage),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.getSessionContextUsage({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(usage);
		expect(sessions.getSessionContextUsage).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
	});

	it("loads session owner user ids through session ports", async () => {
		const sessions = {
			...fakeSessions(),
			getSessionOwnerUserId: vi.fn(async () => "user-owner-1"),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(service.getSessionOwnerUserId("session-1")).resolves.toBe(
			"user-owner-1",
		);
		expect(sessions.getSessionOwnerUserId).toHaveBeenCalledWith({
			sessionId: "session-1",
		});
	});

	it("attaches session runtime metadata through session ports", async () => {
		const sessions = {
			...fakeSessions(),
      attachSessionRuntime: vi.fn(async () => true),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await service.attachSessionRuntime({
			sessionId: "session-1",
			expectedStartedAt: new Date("2026-07-21T12:00:00.000Z"),
			daprInstanceId: "session-1",
			natsSubject: "session.events.session-1",
			runtimeAppId: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
		});

		expect(sessions.attachSessionRuntime).toHaveBeenCalledWith({
			sessionId: "session-1",
			expectedStartedAt: new Date("2026-07-21T12:00:00.000Z"),
			daprInstanceId: "session-1",
			natsSubject: "session.events.session-1",
			runtimeAppId: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
		});
	});

  it("reserves session runtime provisioning through session ports", async () => {
    const lease = { startedAt: new Date("2026-07-21T20:00:00.000Z") };
    const sessions = {
      ...fakeSessions(),
      reserveSessionRuntimeProvisioning: vi.fn(async () => lease),
    } satisfies SessionRepository;
    const { service } = makeService({ sessions });

    await expect(
      service.reserveSessionRuntimeProvisioning({ sessionId: "session-1" }),
    ).resolves.toEqual(lease);
    expect(sessions.reserveSessionRuntimeProvisioning).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
  });

	it("stages an exact unpublished runtime target through session ports", async () => {
		const sessions = {
			...fakeSessions(),
			stageSessionRuntimeProvisioning: vi.fn(async () => true),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });
		const input = {
			sessionId: "session-1",
			expectedStartedAt: new Date("2026-07-21T20:00:00.000Z"),
			runtimeAppId: "shared-runtime",
			durableInstanceId: "session-runtime-generation-1",
			runtimeSandboxName: null,
			runtimeHostOwned: false,
			runtimeHostLaunchSpec: null,
		};

		await expect(
			service.stageSessionRuntimeProvisioning(input),
		).resolves.toBe(true);
		expect(sessions.stageSessionRuntimeProvisioning).toHaveBeenCalledWith(input);
	});

  it("acknowledges runtime provisioning compensation through session ports", async () => {
    const sessions = {
      ...fakeSessions(),
      acknowledgeRuntimeProvisioningCompensation: vi.fn(async () => true),
    } satisfies SessionRepository;
    const { service } = makeService({ sessions });
    const expectedStartedAt = new Date("2026-07-21T20:00:00.000Z");

    await expect(
      service.acknowledgeRuntimeProvisioningCompensation({
        sessionId: "session-1",
        expectedStartedAt,
      }),
    ).resolves.toBe(true);
    expect(
      sessions.acknowledgeRuntimeProvisioningCompensation,
    ).toHaveBeenCalledWith({
      sessionId: "session-1",
      expectedStartedAt,
    });
  });

	it("loads session runtime targets through scoped session ports", async () => {
		const target = {
			appId: "agent-session-1",
			invokeTarget: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
			source: "persisted" as const,
		};
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
			getSessionRuntimeTarget: vi.fn(async () => target),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.getSessionRuntimeTarget({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(target);
		expect(sessions.getSessionRuntimeTarget).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});

		await expect(
			service.getSessionRuntimeTarget({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		expect(sessions.getSessionRuntimeTarget).toHaveBeenCalledTimes(1);
	});

	it("loads session runtime debug targets through scoped session ports", async () => {
		const target = {
			appId: "agent-session-1",
			invokeTarget: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
			source: "persisted" as const,
			agentSlug: "codex-agent",
			agentRuntime: "codex-cli",
		};
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
			getSessionRuntimeDebugTarget: vi.fn(async () => target),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.getSessionRuntimeDebugTarget({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(target);
		expect(sessions.getSessionRuntimeDebugTarget).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});

		await expect(
			service.getSessionRuntimeDebugTarget({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		expect(sessions.getSessionRuntimeDebugTarget).toHaveBeenCalledTimes(1);
	});

	it("loads new-session page metadata through runtime registry ports", async () => {
		const runtimeRegistry = fakeRuntimeRegistry();
		const { service } = makeService({ runtimeRegistry });

		await expect(service.getNewSessionPageReadModel()).resolves.toEqual({
			cliAuthByRuntime: {
				"codex-cli": {
					provider: "openai",
					credentialKind: "file",
					setupCommand: "codex login",
				},
				"agy-cli": {
					provider: "google",
					credentialKind: "file_bundle",
					setupCommand: "agy login",
				},
			},
		});
		expect(runtimeRegistry.listSessionRuntimeCliAuth).toHaveBeenCalledOnce();
	});

	it("loads session runtime compute through scoped runtime status ports", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const target = {
			appId: "agent-session-1",
			invokeTarget: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
			source: "persisted" as const,
			agentSlug: "codex-agent",
			agentRuntime: "codex-cli",
		};
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
			getSessionRuntimeDebugTarget: vi.fn(async () => target),
		} satisfies SessionRepository;
		const sessionRuntimeStatus = fakeSessionRuntimeStatus();
		const { service } = makeService({ sessions, sessionRuntimeStatus });

		await expect(
			service.getSessionRuntimeCompute({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			podName: "agent-session-1-pod",
			usage: {
				name: "agent-session-1-pod",
				cpuMillicores: 123,
				memoryMiB: 456,
			},
			requests: { cpuMillicores: 1000, memoryMiB: 2048 },
		});
		expect(sessionRuntimeStatus.getSessionRuntimeCompute).toHaveBeenCalledWith(
			target,
		);

		await expect(
			service.getSessionRuntimeCompute({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		expect(sessionRuntimeStatus.getSessionRuntimeCompute).toHaveBeenCalledTimes(
			1,
		);
	});

	it("loads session runtime flags through scoped runtime status ports", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const target = {
			appId: "agent-session-1",
			invokeTarget: "agent-session-1",
			runtimeSandboxName: "agent-host-agent-session-1",
			source: "persisted" as const,
			agentSlug: "codex-agent",
			agentRuntime: "codex-cli",
		};
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
			getSessionRuntimeDebugTarget: vi.fn(async () => target),
		} satisfies SessionRepository;
		const sessionRuntimeStatus = fakeSessionRuntimeStatus();
		const { service } = makeService({ sessions, sessionRuntimeStatus });

		await expect(
			service.getSessionRuntimeFlags({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				agentSlug: "codex-agent",
				runtimeAppId: "agent-session-1",
				phase: "Active",
				shellAvailable: true,
			}),
		);
		expect(sessionRuntimeStatus.getSessionRuntimeFlags).toHaveBeenCalledWith(
			target,
		);

		await expect(
			service.getSessionRuntimeFlags({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
    expect(sessionRuntimeStatus.getSessionRuntimeFlags).toHaveBeenCalledTimes(
      1,
    );
	});

	it("loads session control settings through scoped agent read ports", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
			agentId: "agent-1",
			agentVersion: 7,
			environmentId: "environment-1",
			environmentVersion: 2,
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
		} satisfies SessionRepository;
		const workflowAgentReads = fakeWorkflowAgentReads();
		const { service } = makeService({ sessions, workflowAgentReads });

		await expect(
			service.getSessionControlSettings({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			session: sourceSession,
			agent: expect.objectContaining({
				id: "agent-1",
				slug: "settings-agent",
				version: 7,
			}),
			environment: expect.objectContaining({
				id: "environment-1",
				slug: "settings-environment",
				version: 2,
			}),
		});
		expect(
			workflowAgentReads.resolveSessionControlSettingsReferences,
		).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 7,
			environmentId: "environment-1",
			environmentVersion: 2,
		});

		await expect(
			service.getSessionControlSettings({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		expect(
			workflowAgentReads.resolveSessionControlSettingsReferences,
		).toHaveBeenCalledTimes(1);
	});

	it("loads session event stream snapshots through the scoped session repository", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.getSessionEventStreamSnapshot({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toBe(sourceSession);
		await expect(
			service.getSessionEventStreamSnapshot({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		await expect(
			service.getSessionEventStreamSnapshot({
				sessionId: "session-1",
				userId: "user-1",
			}),
		).resolves.toBe(sourceSession);
		await expect(
			service.getSessionEventStreamSnapshot({
				sessionId: "session-1",
				userId: "other-user",
			}),
		).resolves.toBeNull();
		expect(sessions.getSession).toHaveBeenCalledWith("session-1");
	});

	it("loads session details through the scoped session repository", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.getSessionDetail({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toBe(sourceSession);
		await expect(
			service.getSessionDetail({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
	});

	it("mirrors session status updates through the injected session repository", async () => {
		const sessions = {
			...fakeSessions(),
			updateSessionStatus: vi.fn(async () => undefined),
			updateSessionStatusUnlessTerminated: vi.fn(async () => undefined),
		updateSessionStatusRescheduled: vi.fn(async () => undefined),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });
		const pauseRequestedAt = new Date("2026-01-01T00:00:00Z");

		await service.updateSessionStatus({
			id: "session-1",
			status: "paused",
			pauseRequestedAt,
		});
		await service.updateSessionStatusUnlessTerminated({
			id: "session-1",
			status: "idle",
		});

		expect(sessions.updateSessionStatus).toHaveBeenCalledWith({
			id: "session-1",
			status: "paused",
			pauseRequestedAt,
		});
		expect(sessions.updateSessionStatusUnlessTerminated).toHaveBeenCalledWith({
			id: "session-1",
			status: "idle",
		});
	});

	it("builds session goal-flow read models through scoped goal-flow ports", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
		} satisfies SessionRepository;
		const goalFlow = fakeGoalFlow();
		const { service } = makeService({ sessions, goalFlow });

		await expect(
			service.getSessionGoalFlow({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			goalFlow: expect.objectContaining({
				sessionId: "session-1",
				goalId: "goal-1",
				objective: "Ship the migration",
				status: "complete",
				outcome: expect.objectContaining({ verdict: "pass" }),
			}),
		});
		expect(goalFlow.getCurrentGoalForSessions).toHaveBeenCalledWith([
			"session-1",
		]);
		expect(goalFlow.listGoalFlowEvents).toHaveBeenCalledWith({
			sessionId: "session-1",
		});

		vi.mocked(goalFlow.getCurrentGoalForSessions).mockResolvedValueOnce(null);
		await expect(
			service.getSessionGoalFlow({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({ status: "ok", goalFlow: null });

		await expect(
			service.getSessionGoalFlow({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toEqual({ status: "not_found" });
		expect(goalFlow.listGoalFlowEvents).toHaveBeenCalledTimes(1);
	});

	it("manages session resources through scoped repository ports", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const repoResource = {
			id: "resource-1",
			sessionId: "session-1",
			type: "github_repository" as const,
			fileId: null,
			mountPath: "/workspace/repo",
			repoUrl: "https://github.com/example/repo",
			checkoutRef: "main",
			authTokenCredentialId: null,
			appConnectionExternalId: "conn-1",
			mountedAt: null,
			removedAt: null,
		};
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
			listSessionResources: vi.fn(async () => [repoResource]),
			addSessionResource: vi.fn(async () => repoResource),
			removeSessionResource: vi.fn(async () => true),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.listSessionResources({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual([repoResource]);
		expect(sessions.listSessionResources).toHaveBeenCalledWith("session-1");

		await expect(
			service.addSessionResource({
				sessionId: "session-1",
				projectId: "project-1",
				resource: {
					type: "github_repository",
					repoUrl: "https://github.com/example/repo",
					checkoutRef: "main",
					mountPath: "/workspace/repo",
					appConnectionExternalId: "conn-1",
				},
			}),
		).resolves.toEqual({
			status: "created",
			resource: repoResource,
			session: sourceSession,
		});
		expect(sessions.addSessionResource).toHaveBeenCalledWith({
			sessionId: "session-1",
			resource: {
				type: "github_repository",
				repoUrl: "https://github.com/example/repo",
				checkoutRef: "main",
				mountPath: "/workspace/repo",
				appConnectionExternalId: "conn-1",
			},
		});

		await expect(
			service.removeSessionResource({
				sessionId: "session-1",
				resourceId: "resource-1",
				projectId: "project-1",
			}),
		).resolves.toBe(true);
		expect(sessions.removeSessionResource).toHaveBeenCalledWith({
			sessionId: "session-1",
			resourceId: "resource-1",
		});

		await expect(
			service.listSessionResources({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		await expect(
			service.addSessionResource({
				sessionId: "session-1",
				projectId: "other-project",
				resource: { type: "file", fileId: "file-1" },
			}),
		).resolves.toEqual({ status: "not_found" });
		await expect(
			service.removeSessionResource({
				sessionId: "session-1",
				resourceId: "resource-2",
				projectId: "other-project",
			}),
		).resolves.toBe(false);
		expect(sessions.listSessionResources).toHaveBeenCalledTimes(1);
		expect(sessions.addSessionResource).toHaveBeenCalledTimes(1);
		expect(sessions.removeSessionResource).toHaveBeenCalledTimes(1);
	});

	it("updates session titles through the scoped session repository", async () => {
		const updatedSession = {
			id: "session-1",
			title: "Renamed session",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
			updateSessionTitle: vi.fn(async () => updatedSession),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.updateSessionTitle({
				sessionId: "session-1",
				title: "Renamed session",
				projectId: "project-1",
			}),
		).resolves.toBe(updatedSession);
		expect(sessions.updateSessionTitle).toHaveBeenCalledWith({
			id: "session-1",
			title: "Renamed session",
		});

		await expect(
			service.updateSessionTitle({
				sessionId: "session-1",
				title: "Blocked rename",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		expect(sessions.updateSessionTitle).toHaveBeenCalledTimes(1);
	});

	it("archives and deletes sessions through scoped repository commands", async () => {
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
			archiveSession: vi.fn(async () => true),
			deleteSession: vi.fn(async () => true),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.archiveSession({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toBe(true);
		await expect(
			service.deleteSession({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toBe(true);
		expect(sessions.archiveSession).toHaveBeenCalledWith("session-1");
		expect(sessions.deleteSession).toHaveBeenCalledWith("session-1");

		await expect(
			service.archiveSession({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBe(false);
		await expect(
			service.deleteSession({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBe(false);
		expect(sessions.archiveSession).toHaveBeenCalledTimes(1);
		expect(sessions.deleteSession).toHaveBeenCalledTimes(1);
	});

	it("loads a full session event through scoped event-log ports", async () => {
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const { service } = makeService({ sessions, sessionEvents });

		await expect(
			service.getSessionEvent({
				sessionId: "session-1",
				eventId: "event-full",
				projectId: "project-1",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				id: "event-full",
				sessionId: "session-1",
				data: { content: "full payload" },
			}),
		);
		expect(sessionEvents.getSessionEvent).toHaveBeenCalledWith({
			sessionId: "session-1",
			eventId: "event-full",
		});

		await expect(
			service.getSessionEvent({
				sessionId: "session-1",
				eventId: "event-blocked",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
		expect(sessionEvents.getSessionEvent).toHaveBeenCalledTimes(1);
	});

	it("loads session runtime config through a scoped runtime-config reader", async () => {
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
		} satisfies SessionRepository;
		const sessionRuntimeConfigs = fakeSessionRuntimeConfigs();
		const { service } = makeService({ sessions, sessionRuntimeConfigs });

		await expect(
			service.getSessionRuntimeConfig({
				sessionId: "session-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				id: "runtime-config:session-1",
				type: "io.workflow-builder.session.runtime_config.v1",
			}),
		);
		expect(sessionRuntimeConfigs.getSessionRuntimeConfig).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});

		await expect(
			service.getSessionRuntimeConfig({
				sessionId: "session-1",
				projectId: "other-project",
			}),
		).resolves.toBeNull();
    expect(sessionRuntimeConfigs.getSessionRuntimeConfig).toHaveBeenCalledTimes(
      1,
    );
	});

	it("raises session agent config patches through scoped command ports", async () => {
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
		} satisfies SessionRepository;
		const sessionAgentConfigCommands = fakeSessionAgentConfigCommands();
		const { service } = makeService({ sessions, sessionAgentConfigCommands });

		await expect(
			service.raiseSessionAgentConfigPatch({
				sessionId: "session-1",
				projectId: "project-1",
				patch: { modelSpec: "openai/gpt-5.5" },
			}),
		).resolves.toEqual({
			ok: true,
			status: 200,
			patch: { modelSpec: "openai/gpt-5.5" },
		});
		expect(
			sessionAgentConfigCommands.raiseSessionAgentConfigPatch,
		).toHaveBeenCalledWith({
			sessionId: "session-1",
			patch: { modelSpec: "openai/gpt-5.5" },
			session: expect.objectContaining({
				id: "session-1",
				projectId: "project-1",
			}),
		});

		await expect(
			service.raiseSessionAgentConfigPatch({
				sessionId: "session-1",
				projectId: "other-project",
				patch: { modelSpec: "openai/gpt-5.5" },
			}),
		).resolves.toEqual({
			ok: false,
			status: 404,
			error: "Session not found",
		});
		expect(
			sessionAgentConfigCommands.raiseSessionAgentConfigPatch,
		).toHaveBeenCalledTimes(1);
	});

	it("forks a session by replaying event envelopes through session ports", async () => {
		const sourceSession = {
			id: "session-1",
			title: "Source session",
			agentId: "agent-1",
			agentVersion: 2,
			environmentId: "env-1",
			environmentVersion: 3,
			vaultIds: ["vault-1"],
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
			createSessionFork: vi.fn(async () => ({ id: "fork-session-1" })),
		} satisfies SessionRepository;
		const sessionEvents = {
			...fakeSessionEvents(),
			listSessionEvents: vi.fn(async () => [
				{
					id: "source-event-1",
					sessionId: "session-1",
					sequence: 1,
					type: "user.message",
					data: { content: "hello" },
					processedAt: "2026-01-01T00:01:00.000Z",
					sourceEventId: null,
					producerId: null,
					producerEpoch: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					timestamp: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "source-event-2",
					sessionId: "session-1",
					sequence: 2,
					type: "agent.llm_usage",
					data: { input_tokens: 10 },
					processedAt: null,
					sourceEventId: "runtime-event-2",
					producerId: "agent",
					producerEpoch: "epoch-1",
					createdAt: "2026-01-01T00:02:00.000Z",
					timestamp: "2026-01-01T00:02:00.000Z",
				},
			]),
			appendSessionEvent: vi.fn(async (sessionId, event) => ({
				id: `${sessionId}:${event.sourceEventId ?? event.type}`,
				sessionId,
				sequence: 1,
				type: event.type,
				data: event.data ?? {},
				processedAt: event.processedAt?.toISOString() ?? null,
				sourceEventId: event.sourceEventId ?? null,
				producerId: event.producerId ?? null,
				producerEpoch: event.producerEpoch ?? null,
				createdAt: "2026-01-01T00:00:00.000Z",
				timestamp: "2026-01-01T00:00:00.000Z",
			})),
		} satisfies SessionEventLog;
		const { service } = makeService({ sessions, sessionEvents });

		await expect(
			service.forkSessionFromEvent({
				sourceSessionId: "session-1",
				fromSequence: 2,
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "created",
			sessionId: "fork-session-1",
			sourceSessionId: "session-1",
			replayed: 2,
		});
		expect(sessions.createSessionFork).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 2,
			environmentId: "env-1",
			environmentVersion: 3,
			vaultIds: ["vault-1"],
			title: "Fork of Source session @ seq 2",
			userId: "user-1",
			projectId: "project-1",
		});
		expect(sessionEvents.listSessionEvents).toHaveBeenCalledWith("session-1", {
			atOrBeforeSequence: 2,
		});
		expect(sessionEvents.appendSessionEvent).toHaveBeenNthCalledWith(
			1,
			"fork-session-1",
			{
				type: "user.message",
				data: { content: "hello" },
				processedAt: new Date("2026-01-01T00:01:00.000Z"),
				sourceEventId: "fork:source-event-1",
			},
		);
		expect(sessionEvents.appendSessionEvent).toHaveBeenNthCalledWith(
			2,
			"fork-session-1",
			{
				type: "agent.llm_usage",
				data: { input_tokens: 10 },
				processedAt: null,
				sourceEventId: "fork:source-event-2",
			},
		);
	});

	it("appends user events and wakes the session runtime through ports", async () => {
		const sourceSession = {
			id: "session-1",
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const sessionRuntimeEvents = fakeSessionRuntimeEvents();
		const userEvents = [
			{
				type: "user.message" as const,
				content: [{ type: "text" as const, text: "hello" }],
			},
		];
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionRuntimeEvents,
		});

		await expect(
			service.appendSessionUserEvents({
				sessionId: "session-1",
				projectId: "project-1",
				userId: "user-1",
				events: userEvents,
			}),
		).resolves.toEqual({
			status: "ok",
			events: [
				expect.objectContaining({
					sessionId: "session-1",
					type: "user.message",
					data: userEvents[0],
				}),
			],
		});
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "user.message",
			data: userEvents[0],
			processedAt: null,
		});
		expect(sessionRuntimeEvents.raiseSessionUserEvents).toHaveBeenCalledWith(
			"session-1",
			userEvents,
		);
	});

	it("does not append user events for sessions outside scope", async () => {
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				id: "session-1",
				projectId: "project-1",
          }) as Awaited<ReturnType<SessionRepository["getSession"]>>,
      ),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const sessionRuntimeEvents = fakeSessionRuntimeEvents();
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionRuntimeEvents,
		});

		await expect(
			service.appendSessionUserEvents({
				sessionId: "session-1",
				projectId: "other-project",
				userId: "user-1",
				events: [
					{
						type: "user.message",
						content: [{ type: "text", text: "hello" }],
					},
				],
			}),
		).resolves.toEqual({ status: "not_found" });
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
		expect(sessionRuntimeEvents.raiseSessionUserEvents).not.toHaveBeenCalled();
	});

	it("creates workflow dev handoff sessions through session ports", async () => {
		const sessionId = expectedWorkflowDevSessionId("exec-1");
		const sessions = {
			...fakeSessions(),
			ensureSession: vi.fn(async (input) => ({
				session: {
					...sampleSessionDetail(),
					id: sessionId,
					agentId: input.agentId,
					agentVersion: input.agentVersion ?? null,
					projectId: input.projectId ?? null,
					workflowExecutionId: input.workflowExecutionId ?? null,
					title: input.title ?? null,
				} as SessionDetail,
				created: true,
			})),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const sessionAgents = fakePreviewDevSessionAgentResolver({
			slug: "kimi-k3-juicefs-builder-agent",
			config: {
				modelSpec: "kimi/kimi-k3",
				reasoningEffort: "max",
				contextWindowTokens: 1_048_576,
				runtimeIsolation: "dedicated",
			},
		});
		const sessionAgentSlugs = fakeSessionAgentSlugs();
		const workflowExecutions = {
			...fakeWorkflowExecutions(),
			listSessionIdsByExecutionId: vi.fn(async () => [
				"generator-agent-call-session",
				sessionId,
			]),
		} satisfies WorkflowExecutionRepository;
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionAgents,
			sessionAgentSlugs,
			workflowExecutions,
		});

		await expect(
			service.createWorkflowDevSession({
				executionId: "exec-1",
				agentPolicy: {
					slug: "kimi-k3-juicefs-builder-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "kimi/kimi-k3",
					reasoningEffort: "max",
					contextWindowTokens: 1_048_576,
					runtimeIsolation: "dedicated",
				},
				instructions: "open repo",
				title: "Dev handoff",
			}),
		).resolves.toEqual({
			status: "created",
			sessionId,
			agentSlug: "kimi-k3-juicefs-builder-agent",
		});
		expect(workflowExecutions.getSessionOwnerContext).toHaveBeenCalledWith(
			"exec-1",
		);
		expect(sessionAgentSlugs.resolveSessionAgentIdBySlug).toHaveBeenCalledWith(
			"kimi-k3-juicefs-builder-agent",
		);
		expect(sessionAgents.resolveSessionAgent).toHaveBeenCalledWith({
			agentId: "agent-1",
		});
		expect(sessions.ensureSession).toHaveBeenCalledWith({
			id: sessionId,
			agentId: "agent-1",
			agentVersion: 7,
			userId: "user-1",
			projectId: "project-1",
			workflowExecutionId: "exec-1",
			title: "Dev handoff",
		});
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith(sessionId, {
			type: "user.message",
			data: {
				type: "user.message",
				content: [{ type: "text", text: "open repo" }],
				origin: "preview-development-workflow",
				provenance: {
					contract: "workflow-dev-session-kickoff/v1",
					workflowExecutionId: "exec-1",
					instructionsSha256: createHash("sha256")
						.update("open repo", "utf8")
						.digest("hex"),
					title: "Dev handoff",
					agentSlug: "kimi-k3-juicefs-builder-agent",
					agentRuntime: "dapr-agent-py-juicefs",
					modelSpec: "kimi/kimi-k3",
					reasoningEffort: "max",
					contextWindowTokens: 1_048_576,
					runtimeIsolation: "dedicated",
				},
			},
			processedAt: null,
			sourceEventId: "workflow-dev-session:kickoff:v1",
		});
	});

	it("reuses a pinned pre-migration dev handoff without resolving the canonical agent", async () => {
		const executionId = "exec-legacy-replay";
		const sessionId = expectedWorkflowDevSessionId(executionId);
		const session = {
			...sampleSessionDetail(),
			id: sessionId,
			title: "Dev handoff",
			agentId: "legacy-agent",
			agentVersion: 3,
			projectId: "project-1",
			workflowExecutionId: executionId,
		} as SessionDetail;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async (id) => (id === sessionId ? session : null)),
			getSessionFileOwner: vi.fn(async (id) =>
				id === sessionId
					? { id, userId: "user-1", projectId: "project-1" }
					: null,
			),
		} satisfies SessionRepository;
		const legacyKickoffData = {
			type: "user.message",
			content: [{ type: "text", text: "open repo" }],
			origin: "preview-development-workflow",
			provenance: {
				contract: "workflow-dev-session-kickoff/v1",
				workflowExecutionId: executionId,
				instructionsSha256: createHash("sha256")
					.update("open repo", "utf8")
					.digest("hex"),
				title: "Dev handoff",
				agentSlug: "glm-juicefs-builder-agent",
				agentRuntime: "dapr-agent-py-juicefs",
				modelSpec: "kimi/kimi-k3",
			},
		};
		const sessionEvents = {
			...fakeSessionEvents(),
			appendSessionEvent: vi.fn(async (id) => ({
				id: "legacy-kickoff-1",
				sessionId: id,
				sequence: 1,
				type: "user.message",
				data: legacyKickoffData,
				processedAt: null,
				sourceEventId: "workflow-dev-session:kickoff:v1",
				producerId: null,
				producerEpoch: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				timestamp: "2026-01-01T00:00:00.000Z",
			})),
		} satisfies SessionEventLog;
		const legacyAgent = await fakePreviewDevSessionAgentResolver({
			slug: "glm-juicefs-builder-agent",
			config: {
				modelSpec: "kimi/kimi-k3",
				reasoningEffort: "max",
				contextWindowTokens: 1_048_576,
				runtimeIsolation: "dedicated",
			},
		}).resolveSessionAgent({ agentId: "legacy-agent", agentVersion: 3 });
		if (!legacyAgent) throw new Error("legacy agent fixture missing");
		const sessionAgents = {
			resolveSessionAgent: vi.fn(async (input) =>
				input.agentId === "legacy-agent" && input.agentVersion === 3
					? { ...legacyAgent, id: "legacy-agent", version: 3 }
					: null,
			),
		} satisfies SessionAgentResolver;
		const sessionAgentSlugs = fakeSessionAgentSlugs();
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionAgents,
			sessionAgentSlugs,
			workflowExecutions: {
				...fakeWorkflowExecutions(),
				listSessionIdsByExecutionId: vi.fn(async () => [sessionId]),
			} satisfies WorkflowExecutionRepository,
		});

		await expect(
			service.createWorkflowDevSession({
				executionId,
				agentPolicy: {
					slug: "kimi-k3-juicefs-builder-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "kimi/kimi-k3",
					reasoningEffort: "max",
					contextWindowTokens: 1_048_576,
					runtimeIsolation: "dedicated",
				},
				replayAgentPolicies: [
					{
						slug: "glm-juicefs-builder-agent",
						runtime: "dapr-agent-py-juicefs",
						modelSpec: "kimi/kimi-k3",
					},
				],
				instructions: "open repo",
				title: "Dev handoff",
			}),
		).resolves.toEqual({
			status: "reused",
			sessionId,
			agentSlug: "glm-juicefs-builder-agent",
		});
    expect(
      sessionAgentSlugs.resolveSessionAgentIdBySlug,
    ).not.toHaveBeenCalled();
		expect(sessions.ensureSession).not.toHaveBeenCalled();
		expect(sessionAgents.resolveSessionAgent).toHaveBeenCalledWith({
			agentId: "legacy-agent",
			agentVersion: 3,
		});
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith(sessionId, {
			type: "user.message",
			data: legacyKickoffData,
			processedAt: null,
			sourceEventId: "workflow-dev-session:kickoff:v1",
		});
	});

	it("fails closed when a pinned replay agent is not an explicit compatibility policy", async () => {
		const executionId = "exec-legacy-drift";
		const sessionId = expectedWorkflowDevSessionId(executionId);
		const sessions = {
			...fakeSessions(),
      getSession: vi.fn(
        async () =>
          ({
				...sampleSessionDetail(),
				id: sessionId,
				title: "Dev handoff",
				agentId: "legacy-agent",
				agentVersion: 2,
				projectId: "project-1",
				workflowExecutionId: executionId,
          }) as SessionDetail,
      ),
			getSessionFileOwner: vi.fn(async () => ({
				id: sessionId,
				userId: "user-1",
				projectId: "project-1",
			})),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const sessionAgentSlugs = fakeSessionAgentSlugs();
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionAgentSlugs,
			sessionAgents: fakePreviewDevSessionAgentResolver({
				slug: "glm-juicefs-builder-agent",
				config: { modelSpec: "zai/glm-5.2" },
			}),
			workflowExecutions: fakeWorkflowExecutions(),
		});

		await expect(
			service.createWorkflowDevSession({
				executionId,
				agentPolicy: {
					slug: "kimi-k3-juicefs-builder-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "kimi/kimi-k3",
					reasoningEffort: "max",
					contextWindowTokens: 1_048_576,
					runtimeIsolation: "dedicated",
				},
				replayAgentPolicies: [
					{
						slug: "glm-juicefs-builder-agent",
						runtime: "dapr-agent-py-juicefs",
						modelSpec: "kimi/kimi-k3",
					},
				],
				instructions: "open repo",
				title: "Dev handoff",
			}),
		).resolves.toEqual({
			status: "session_conflict",
			reason: "identity_mismatch",
		});
    expect(
      sessionAgentSlugs.resolveSessionAgentIdBySlug,
    ).not.toHaveBeenCalled();
		expect(sessions.ensureSession).not.toHaveBeenCalled();
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("converges concurrent workflow dev-session retries on one session and kickoff", async () => {
		const executionId = "exec-concurrent";
		const sessionId = expectedWorkflowDevSessionId(executionId);
		let durableSession: SessionDetail | null = null;
    let durableKickoff: Awaited<
      ReturnType<SessionEventLog["appendSessionEvent"]>
    > | null = null;
		let durableKickoffWrites = 0;
		const sessions = {
			...fakeSessions(),
			ensureSession: vi.fn(async (input) => {
				if (durableSession) return { session: durableSession, created: false };
				durableSession = {
					...sampleSessionDetail(),
					id: input.id,
					title: input.title ?? null,
					agentId: input.agentId,
					agentVersion: input.agentVersion ?? null,
					projectId: input.projectId ?? null,
					workflowExecutionId: input.workflowExecutionId ?? null,
				};
				return { session: durableSession, created: true };
			}),
			getSessionFileOwner: vi.fn(async (id) =>
        id === sessionId
          ? { id, userId: "user-1", projectId: "project-1" }
          : null,
			),
		} satisfies SessionRepository;
		const sessionEvents = {
			...fakeSessionEvents(),
			appendSessionEvent: vi.fn(async (id, event) => {
				if (durableKickoff) return durableKickoff;
				durableKickoffWrites += 1;
				durableKickoff = {
					id: "kickoff-1",
					sessionId: id,
					sequence: 1,
					type: event.type,
					data: event.data ?? {},
					processedAt: null,
					sourceEventId: event.sourceEventId ?? null,
					producerId: null,
					producerEpoch: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					timestamp: "2026-01-01T00:00:00.000Z",
				};
				return durableKickoff;
			}),
		} satisfies SessionEventLog;
		const workflowExecutions = {
			...fakeWorkflowExecutions(),
			listSessionIdsByExecutionId: vi.fn(async () =>
				durableSession ? [durableSession.id] : [],
			),
		} satisfies WorkflowExecutionRepository;
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionAgents: fakePreviewDevSessionAgentResolver(),
			sessionAgentSlugs: fakeSessionAgentSlugs(),
			workflowExecutions,
		});
		const request = {
			executionId,
			agentPolicy: {
				slug: "dapr-juicefs-dev-agent",
				runtime: "dapr-agent-py-juicefs" as const,
				modelSpec: "deepseek-v4-pro",
			},
			instructions: "open repo",
		};

		const results = await Promise.all([
			service.createWorkflowDevSession(request),
			service.createWorkflowDevSession(request),
		]);

		expect(results).toEqual([
			{
				status: "created",
				sessionId,
				agentSlug: "dapr-juicefs-dev-agent",
			},
			{
				status: "reused",
				sessionId,
				agentSlug: "dapr-juicefs-dev-agent",
			},
		]);
		expect(durableKickoffWrites).toBe(1);
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledTimes(2);
	});

	it("fails closed when a replay changes the durable kickoff instructions", async () => {
		const executionId = "exec-replay";
		const sessionId = expectedWorkflowDevSessionId(executionId);
		const session = {
			...sampleSessionDetail(),
			id: sessionId,
			title: `Dev session (${executionId})`,
			agentId: "agent-1",
			agentVersion: 7,
			projectId: "project-1",
			workflowExecutionId: executionId,
		};
		const sessions = {
			...fakeSessions(),
			ensureSession: vi.fn(async () => ({ session, created: false })),
			getSessionFileOwner: vi.fn(async () => ({
				id: sessionId,
				userId: "user-1",
				projectId: "project-1",
			})),
		} satisfies SessionRepository;
		const sessionEvents = {
			...fakeSessionEvents(),
			appendSessionEvent: vi.fn(async (id, event) => ({
				id: "kickoff-1",
				sessionId: id,
				sequence: 1,
				type: event.type,
				data: {
					...(event.data ?? {}),
					content: [{ type: "text", text: "different task" }],
				},
				processedAt: null,
				sourceEventId: event.sourceEventId ?? null,
				producerId: null,
				producerEpoch: null,
				createdAt: "2026-01-01T00:00:00.000Z",
				timestamp: "2026-01-01T00:00:00.000Z",
			})),
		} satisfies SessionEventLog;
		const workflowExecutions = {
			...fakeWorkflowExecutions(),
			listSessionIdsByExecutionId: vi.fn(async () => [sessionId]),
		} satisfies WorkflowExecutionRepository;
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionAgents: fakePreviewDevSessionAgentResolver(),
			sessionAgentSlugs: fakeSessionAgentSlugs(),
			workflowExecutions,
		});

		await expect(
			service.createWorkflowDevSession({
				executionId,
				agentPolicy: {
					slug: "dapr-juicefs-dev-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "deepseek-v4-pro",
				},
				instructions: "open repo",
			}),
		).resolves.toEqual({
			status: "session_conflict",
			reason: "instructions_mismatch",
		});
	});

	it("allows workflow agent-call sessions to coexist with the deterministic handoff", async () => {
		const executionId = "exec-with-agent-call";
		const sessionId = expectedWorkflowDevSessionId(executionId);
		const sessions = {
			...fakeSessions(),
			ensureSession: vi.fn(async (input) => ({
				session: {
					...sampleSessionDetail(),
					id: input.id,
					title: input.title ?? null,
					agentId: input.agentId,
					agentVersion: input.agentVersion ?? null,
					projectId: input.projectId ?? null,
					workflowExecutionId: input.workflowExecutionId ?? null,
				} as SessionDetail,
				created: true,
			})),
			getSessionFileOwner: vi.fn(async (id) =>
        id === sessionId
          ? { id, userId: "user-1", projectId: "project-1" }
          : null,
			),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const workflowExecutions = {
			...fakeWorkflowExecutions(),
			listSessionIdsByExecutionId: vi.fn(async () => [
				"generator-agent-call-session",
				sessionId,
			]),
		} satisfies WorkflowExecutionRepository;
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionAgents: fakePreviewDevSessionAgentResolver(),
			sessionAgentSlugs: fakeSessionAgentSlugs(),
			workflowExecutions,
		});

		await expect(
			service.createWorkflowDevSession({
				executionId,
				agentPolicy: {
					slug: "dapr-juicefs-dev-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "deepseek-v4-pro",
				},
				instructions: "open repo",
			}),
		).resolves.toEqual({
			status: "created",
			sessionId,
			agentSlug: "dapr-juicefs-dev-agent",
		});
		expect(sessions.ensureSession).toHaveBeenCalledTimes(1);
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledTimes(1);
	});

	it("fails closed when the handoff session is not linked to the execution", async () => {
		const sessionId = expectedWorkflowDevSessionId("exec-unlinked");
		const sessions = {
			...fakeSessions(),
			ensureSession: vi.fn(async (input) => ({
				session: {
					...sampleSessionDetail(),
					id: input.id,
					title: input.title ?? null,
					agentId: input.agentId,
					agentVersion: input.agentVersion ?? null,
					projectId: input.projectId ?? null,
					workflowExecutionId: input.workflowExecutionId ?? null,
				} as SessionDetail,
				created: true,
			})),
			getSessionFileOwner: vi.fn(async (id) =>
        id === sessionId
          ? { id, userId: "user-1", projectId: "project-1" }
          : null,
			),
		} satisfies SessionRepository;
		const { service } = makeService({
			sessions,
			sessionEvents: fakeSessionEvents(),
			sessionAgents: fakePreviewDevSessionAgentResolver(),
			sessionAgentSlugs: fakeSessionAgentSlugs(),
			workflowExecutions: {
				...fakeWorkflowExecutions(),
				listSessionIdsByExecutionId: vi.fn(async () => [
					"generator-agent-call-session",
				]),
			} satisfies WorkflowExecutionRepository,
		});

		await expect(
			service.createWorkflowDevSession({
				executionId: "exec-unlinked",
				agentPolicy: {
					slug: "dapr-juicefs-dev-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "deepseek-v4-pro",
				},
				instructions: "open repo",
			}),
		).resolves.toEqual({
			status: "session_conflict",
			reason: "ambiguous",
		});
	});

	it("resolves session agents through the configured session-agent port", async () => {
		const sessionAgents = fakeSessionAgentResolver();
		const { service } = makeService({ sessionAgents });

		await expect(
			service.resolveSessionAgent({
				agentId: "agent-1",
				agentVersion: 4,
			}),
		).resolves.toMatchObject({
			id: "agent-1",
			version: 4,
			projectId: "project-1",
		});
		expect(sessionAgents.resolveSessionAgent).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 4,
		});
	});

	it("resolves session agents by id ref through the configured session-agent port", async () => {
		const sessionAgents = fakeSessionAgentResolver();
		const sessionAgentSlugs = fakeSessionAgentSlugs();
		const { service } = makeService({ sessionAgents, sessionAgentSlugs });

		await expect(
			service.resolveSessionAgentByRef({
				id: "agent-1",
				version: 5,
			}),
		).resolves.toMatchObject({
			id: "agent-1",
			version: 5,
		});
		expect(sessionAgents.resolveSessionAgent).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 5,
		});
    expect(
      sessionAgentSlugs.resolveSessionAgentIdBySlug,
    ).not.toHaveBeenCalled();
	});

	it("resolves session agents by slug ref through configured slug and agent ports", async () => {
		const sessionAgents = fakeSessionAgentResolver();
		const sessionAgentSlugs = fakeSessionAgentSlugs();
		const { service } = makeService({ sessionAgents, sessionAgentSlugs });

		await expect(
			service.resolveSessionAgentByRef({
				slug: "cli-dev-agent",
				version: 6,
			}),
		).resolves.toMatchObject({
			id: "agent-1",
			version: 6,
		});
		expect(sessionAgentSlugs.resolveSessionAgentIdBySlug).toHaveBeenCalledWith(
			"cli-dev-agent",
		);
		expect(sessionAgents.resolveSessionAgent).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 6,
		});
	});

	it("does not create workflow dev sessions without an execution owner", async () => {
		const sessions = fakeSessions();
		const sessionEvents = fakeSessionEvents();
		const workflowExecutions = {
			...fakeWorkflowExecutions(),
			getSessionOwnerContext: vi.fn(async () => null),
		} satisfies WorkflowExecutionRepository;
		const { service } = makeService({
			sessions,
			sessionEvents,
			workflowExecutions,
		});

		await expect(
			service.createWorkflowDevSession({
				executionId: "missing-exec",
				agentPolicy: {
					slug: "dapr-juicefs-dev-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "deepseek-v4-pro",
				},
				instructions: "open repo",
			}),
		).resolves.toEqual({ status: "execution_not_found" });
		expect(sessions.ensureSession).not.toHaveBeenCalled();
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it("does not create workflow dev sessions without a resolvable agent", async () => {
		const sessions = fakeSessions();
		const sessionEvents = fakeSessionEvents();
		const sessionAgentSlugs = {
			resolveSessionAgentIdBySlug: vi.fn(async () => null),
		} satisfies SessionAgentSlugResolver;
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionAgentSlugs,
			workflowExecutions: fakeWorkflowExecutions(),
		});

		await expect(
			service.createWorkflowDevSession({
				executionId: "exec-1",
				agentPolicy: {
					slug: "dapr-juicefs-dev-agent",
					runtime: "dapr-agent-py-juicefs",
					modelSpec: "deepseek-v4-pro",
				},
				instructions: "open repo",
			}),
		).resolves.toEqual({
			status: "agent_not_found",
			agentSlug: "dapr-juicefs-dev-agent",
		});
		expect(sessions.ensureSession).not.toHaveBeenCalled();
		expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
	});

	it.each([
		["slug", { slug: "other-agent" }],
		["row runtime", { rowRuntime: "codex-cli" }],
		["version runtime", { config: { runtime: "codex-cli" as const } }],
		["model", { config: { modelSpec: "openai/gpt-5-mini" } }],
	])(
		"rejects workflow dev agents with a mismatched %s before side effects",
		async (_field, overrides) => {
			const sessions = fakeSessions();
			const sessionEvents = fakeSessionEvents();
			const { service } = makeService({
				sessions,
				sessionEvents,
				sessionAgents: fakePreviewDevSessionAgentResolver(overrides),
				workflowExecutions: fakeWorkflowExecutions(),
			});

			await expect(
				service.createWorkflowDevSession({
					executionId: "exec-1",
					agentPolicy: {
						slug: "dapr-juicefs-dev-agent",
						runtime: "dapr-agent-py-juicefs",
						modelSpec: "deepseek-v4-pro",
					},
					instructions: "open repo",
				}),
			).resolves.toEqual({
				status: "agent_policy_mismatch",
				agentSlug: "dapr-juicefs-dev-agent",
			});
			expect(sessions.ensureSession).not.toHaveBeenCalled();
			expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
		},
	);

	it.each([
		["reasoning effort", { reasoningEffort: "high" as const }],
		["context window", { contextWindowTokens: 262_144 }],
		["runtime isolation", { runtimeIsolation: "shared" as const }],
	])(
		"rejects Kimi K3 workflow dev agents with mismatched %s before side effects",
		async (_field, configOverride) => {
			const sessions = fakeSessions();
			const sessionEvents = fakeSessionEvents();
			const { service } = makeService({
				sessions,
				sessionEvents,
				sessionAgents: fakePreviewDevSessionAgentResolver({
					slug: "kimi-k3-juicefs-builder-agent",
					config: {
						modelSpec: "kimi/kimi-k3",
						reasoningEffort: "max" as const,
						contextWindowTokens: 1_048_576,
						runtimeIsolation: "dedicated",
						...configOverride,
					},
				}),
				workflowExecutions: fakeWorkflowExecutions(),
			});

			await expect(
				service.createWorkflowDevSession({
					executionId: "exec-1",
					agentPolicy: {
						slug: "kimi-k3-juicefs-builder-agent",
						runtime: "dapr-agent-py-juicefs",
						modelSpec: "kimi/kimi-k3",
						reasoningEffort: "max",
						contextWindowTokens: 1_048_576,
						runtimeIsolation: "dedicated",
					},
					instructions: "open repo",
				}),
			).resolves.toEqual({
				status: "agent_policy_mismatch",
				agentSlug: "kimi-k3-juicefs-builder-agent",
			});
			expect(sessions.ensureSession).not.toHaveBeenCalled();
			expect(sessionEvents.appendSessionEvent).not.toHaveBeenCalled();
		},
	);

	it("creates a session experiment agent when fork config differs", async () => {
		const sourceSession = {
			id: "session-1",
			title: "Source session",
			agentId: "agent-1",
			agentVersion: 2,
			environmentId: "env-1",
			environmentVersion: 3,
			vaultIds: ["vault-1"],
			projectId: "project-1",
		} as Awaited<ReturnType<SessionRepository["getSession"]>>;
		const sessions = {
			...fakeSessions(),
			getSession: vi.fn(async () => sourceSession),
			createSessionFork: vi.fn(async () => ({ id: "fork-session-1" })),
		} satisfies SessionRepository;
		const sessionEvents = fakeSessionEvents();
		const sessionExperimentAgents = fakeSessionExperimentAgents();
		const tweakedConfig = {
			...createDefaultAgentConfig(),
			systemPrompt: "Tweaked prompt",
		};
		const { service } = makeService({
			sessions,
			sessionEvents,
			sessionExperimentAgents,
		});

		await expect(
			service.forkSessionFromEvent({
				sourceSessionId: "session-1",
				fromSequence: 1,
				agentConfig: tweakedConfig,
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			status: "created",
			sessionId: "fork-session-1",
		});
    expect(
      sessionExperimentAgents.resolveSessionForkBaseAgent,
    ).toHaveBeenCalledWith({
			agentId: "agent-1",
			agentVersion: 2,
		});
		expect(
			sessionExperimentAgents.findOrCreateSessionExperimentAgent,
		).toHaveBeenCalledWith({
			baseAgentId: "agent-1",
			baseAgentSlug: "base-agent",
			baseAgentName: "Base Agent",
			agentConfig: tweakedConfig,
			userId: "user-1",
			projectId: "project-1",
		});
		expect(sessions.createSessionFork).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "experiment-agent-1",
				agentVersion: 1,
			}),
		);
	});

	it("delegates browser artifact reads to the browser artifact store", async () => {
		const saved = {
			id: "bwf_1",
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "publish_shot",
			workspaceRef: null,
			artifactType: "capture_flow_v1" as const,
			artifactVersion: 1,
			status: "completed" as const,
			manifestJson: {},
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const browserArtifacts = {
			save: vi.fn(async () => saved),
			listByExecutionId: vi.fn(async () => [saved]),
			getBlobPayload: vi.fn(async () => ({
				payloadBase64: "aGVsbG8=",
				contentType: "image/png",
			})),
		} satisfies WorkflowBrowserArtifactStore;
		const { service } = makeService({ browserArtifacts });

		await expect(
			service.listWorkflowBrowserArtifactsByExecutionId("exec-1"),
		).resolves.toEqual([saved]);
		await expect(
      service.getWorkflowBrowserBlobPayload(
        "workflow-browser-artifacts/exec-1/bwf_1/shot.png",
      ),
		).resolves.toEqual({
			payloadBase64: "aGVsbG8=",
			contentType: "image/png",
		});
		expect(browserArtifacts.listByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(browserArtifacts.getBlobPayload).toHaveBeenCalledWith(
			"workflow-browser-artifacts/exec-1/bwf_1/shot.png",
		);
	});

	it("loads user profile data through the user profile port", async () => {
		const userProfiles: UserProfileRepository = {
			getUserProfile: vi.fn(async () => ({
				name: "Ada",
				email: "ada@example.test",
				image: null,
				platformRole: "ADMIN" as const,
			})),
		};
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles,
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(service.getUserProfile("user-1")).resolves.toEqual({
			name: "Ada",
			email: "ada@example.test",
			image: null,
			platformRole: "ADMIN",
		});
		await expect(service.isPlatformAdmin("user-1")).resolves.toBe(true);
		vi.mocked(userProfiles.getUserProfile).mockResolvedValueOnce({
			name: "Grace",
			email: "grace@example.test",
			image: null,
			platformRole: "MEMBER",
		});
		await expect(service.isPlatformAdmin("user-2")).resolves.toBe(false);
		expect(userProfiles.getUserProfile).toHaveBeenCalledWith("user-1");
		expect(userProfiles.getUserProfile).toHaveBeenCalledWith("user-2");
	});

	it("composes settings profile and OAuth app rows through settings ports", async () => {
		const settings = {
			getSettingsUserProfile: vi.fn(async () => ({
				id: "user-1",
				name: "Ada",
				email: "ada@example.test",
				image: null,
				platformId: null,
				platformRole: "ADMIN",
			})),
			listPlatformOAuthApps: vi.fn(async () => [
				{
					id: "oauth-1",
					pieceName: "@activepieces/piece-github",
					clientId: "client-1",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					updatedAt: new Date("2026-01-02T00:00:00.000Z"),
				},
				{
					id: "oauth-legacy",
					pieceName: "@activepieces/piece-custom-tool",
					clientId: "client-legacy",
					createdAt: new Date("2026-01-03T00:00:00.000Z"),
					updatedAt: new Date("2026-01-04T00:00:00.000Z"),
				},
			]),
			listOAuthPieces: vi.fn(async () => [
				{
					name: "github",
					displayName: "GitHub",
					logoUrl: "https://example.test/github.svg",
				},
				{ name: "slack", displayName: "Slack", logoUrl: null },
			]),
      resolvePlatformId: vi.fn(
        async (sessionPlatformId) => sessionPlatformId ?? "platform-1",
      ),
			savePlatformOAuthApp: vi.fn(async () => null),
			deletePlatformOAuthApp: vi.fn(async () => undefined),
		} satisfies SettingsRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings,
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.getSettingsPageReadModel({
				userId: "user-1",
				sessionPlatformId: "platform-session",
			}),
		).resolves.toMatchObject({
			profile: { id: "user-1", name: "Ada" },
			oauthApps: [
				{
					id: "oauth-legacy",
					pieceName: "@activepieces/piece-custom-tool",
					clientId: "client-legacy",
					displayName: "Custom Tool",
					configured: true,
				},
				{
					id: "oauth-1",
					pieceName: "@activepieces/piece-github",
					clientId: "client-1",
					displayName: "GitHub",
					configured: true,
				},
				{
					id: null,
					pieceName: "@activepieces/piece-slack",
					clientId: "",
					displayName: "Slack",
					configured: false,
				},
			],
		});
		expect(settings.getSettingsUserProfile).toHaveBeenCalledWith("user-1");
    expect(settings.listPlatformOAuthApps).toHaveBeenCalledWith(
      "platform-session",
    );
		expect(settings.listOAuthPieces).toHaveBeenCalled();
	});

	it("saves and deletes platform OAuth apps through settings ports", async () => {
		const settings = {
			...fakeSettings(),
      resolvePlatformId: vi.fn(
        async (sessionPlatformId) => sessionPlatformId ?? "platform-1",
      ),
			savePlatformOAuthApp: vi.fn(async (input) => ({
				id: input.id ?? "oauth-app-1",
				platformId: input.platformId ?? "platform-1",
				pieceName: input.pieceName,
				clientId: input.clientId,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
			deletePlatformOAuthApp: vi.fn(async () => undefined),
		} satisfies SettingsRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings,
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.savePlatformOAuthApp({
				sessionPlatformId: "platform-session",
				pieceName: " @activepieces/piece-github ",
				clientId: " client-1 ",
				clientSecret: " secret-1 ",
			}),
		).resolves.toMatchObject({
			success: true,
			app: {
				platformId: "platform-session",
				pieceName: "@activepieces/piece-github",
				clientId: "client-1",
			},
		});
		expect(settings.resolvePlatformId).toHaveBeenCalledWith("platform-session");
		expect(settings.savePlatformOAuthApp).toHaveBeenLastCalledWith(
			expect.objectContaining({
				platformId: "platform-session",
				pieceName: "@activepieces/piece-github",
				clientId: "client-1",
				encryptedClientSecret: expect.objectContaining({
					iv: expect.any(String),
					data: expect.any(String),
				}),
			}),
		);

		await expect(
			service.savePlatformOAuthApp({
				id: "oauth-app-1",
				pieceName: "@activepieces/piece-github",
				clientId: "client-2",
			}),
		).resolves.toEqual({ success: true });
		expect(settings.savePlatformOAuthApp).toHaveBeenLastCalledWith({
			id: "oauth-app-1",
			pieceName: "@activepieces/piece-github",
			clientId: "client-2",
			encryptedClientSecret: null,
		});

		await service.deletePlatformOAuthApp("oauth-app-1");
		expect(settings.deletePlatformOAuthApp).toHaveBeenCalledWith("oauth-app-1");
	});

	it("creates piece MCP connections through MCP repositories with credential binding", async () => {
		const mcpConnections = fakeMcpConnections();
		const service = makeServiceWithMcp(mcpConnections);

		await expect(
			service.createProjectMcpConnection({
				projectId: "project-1",
				userId: "user-1",
				sourceType: "nimble_piece",
				pieceName: "@activepieces/piece-github",
				displayName: " GitHub Tools ",
				connectionExternalId: " app-conn-1 ",
				metadata: { toolSelection: { tools: ["create_issue"] } },
			}),
		).resolves.toMatchObject({
			ok: true,
			status: 201,
			connection: {
				projectId: "project-1",
				sourceType: "nimble_piece",
				pieceName: "github",
				connectionExternalId: "app-conn-1",
			},
		});

    expect(
      mcpConnections.activeAppConnectionExistsForPiece,
    ).toHaveBeenCalledWith({
			projectId: "project-1",
			externalId: "app-conn-1",
			pieceNameCandidates: ["github", "@activepieces/piece-github"],
		});
		expect(mcpConnections.createProjectConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				sourceType: "nimble_piece",
				pieceName: "github",
				connectionExternalId: "app-conn-1",
				displayName: "GitHub Tools",
				registryRef: "ap-github-service",
				serverUrl: "http://ap-github-service/mcp",
				status: "ENABLED",
				metadata: {
					transport: "streamable_http",
					toolSelection: { tools: ["create_issue"] },
				},
				createdBy: "user-1",
				updatedBy: "user-1",
			}),
		);
	});

	it("updates existing piece MCP connections instead of duplicating them", async () => {
		const mcpConnections = {
			...fakeMcpConnections(),
			findProjectNimblePieceConnection: vi.fn(async () =>
				mcpConnection({ id: "mcp-existing", pieceName: "github" }),
			),
		} satisfies McpConnectionRepository;
		const service = makeServiceWithMcp(mcpConnections);

		await expect(
			service.createProjectMcpConnection({
				projectId: "project-1",
				userId: "user-1",
				sourceType: "nimble_piece",
				pieceName: "github",
			}),
		).resolves.toMatchObject({
			ok: true,
			status: 200,
			connection: { id: "mcp-existing" },
		});

		expect(mcpConnections.createProjectConnection).not.toHaveBeenCalled();
		expect(mcpConnections.updateProjectConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "mcp-existing",
				projectId: "project-1",
				displayName: "Github",
				status: "ENABLED",
				updatedBy: "user-1",
			}),
		);
	});

	it("rejects MCP credential bindings that do not belong to the project and piece", async () => {
		const mcpConnections = {
			...fakeMcpConnections(),
			activeAppConnectionExistsForPiece: vi.fn(async () => false),
		} satisfies McpConnectionRepository;
		const service = makeServiceWithMcp(mcpConnections);

		await expect(
			service.createProjectMcpConnection({
				projectId: "project-1",
				userId: "user-1",
				sourceType: "nimble_piece",
				pieceName: "github",
				connectionExternalId: "wrong-connection",
			}),
		).resolves.toEqual({
			ok: false,
			status: 400,
			message:
				"connectionExternalId must reference an active app connection for the same piece",
		});
		expect(mcpConnections.createProjectConnection).not.toHaveBeenCalled();
	});

	it("updates MCP connection status, credential binding, and tool selection metadata", async () => {
		const mcpConnections = {
			...fakeMcpConnections(),
			findProjectConnection: vi.fn(async () =>
				mcpConnection({
					id: "mcp-1",
					metadata: {
						transport: "streamable_http",
						toolSelection: { tools: ["old_tool"] },
					},
				}),
			),
		} satisfies McpConnectionRepository;
		const service = makeServiceWithMcp(mcpConnections);

		await expect(
			service.updateProjectMcpConnection({
				id: "mcp-1",
				projectId: "project-1",
				userId: "user-1",
				status: "DISABLED",
				connectionExternalIdProvided: true,
				connectionExternalId: "",
				toolSelectionProvided: true,
				toolSelection: { tools: ["new_tool", "new_tool", " "] },
			}),
		).resolves.toMatchObject({
			ok: true,
			status: 200,
			connection: {
				id: "mcp-1",
				status: "DISABLED",
				connectionExternalId: null,
			},
		});

		expect(mcpConnections.updateProjectConnection).toHaveBeenCalledWith({
			id: "mcp-1",
			projectId: "project-1",
			updatedBy: "user-1",
			status: "DISABLED",
			connectionExternalId: null,
			metadata: {
				transport: "streamable_http",
				toolSelection: { tools: ["new_tool"] },
			},
		});
	});

	it("blocks hosted workflow MCP deletes and deletes normal project MCP rows", async () => {
		const mcpConnections = {
			...fakeMcpConnections(),
			findProjectConnection: vi
				.fn()
				.mockResolvedValueOnce(mcpConnection({ sourceType: "hosted_workflow" }))
				.mockResolvedValueOnce(mcpConnection({ sourceType: "custom_url" })),
		} satisfies McpConnectionRepository;
		const service = makeServiceWithMcp(mcpConnections);

		await expect(
      service.deleteProjectMcpConnection({
        id: "hosted-1",
        projectId: "project-1",
      }),
		).resolves.toEqual({
			ok: false,
			status: 400,
			message: "Cannot delete hosted workflow connections",
		});
		await expect(
      service.deleteProjectMcpConnection({
        id: "custom-1",
        projectId: "project-1",
      }),
		).resolves.toEqual({ ok: true });
		expect(mcpConnections.deleteProjectConnection).toHaveBeenCalledWith({
			id: "custom-1",
			projectId: "project-1",
		});
	});

	it("discovers MCP tool names from persisted connection metadata", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const mcpConnections = {
			...fakeMcpConnections(),
			findProjectConnection: vi.fn(async () =>
				mcpConnection({
					metadata: {
            toolNames: [
              "create_issue",
              { name: "list_issues" },
              "create_issue",
            ],
					},
				}),
			),
		} satisfies McpConnectionRepository;
		const service = makeServiceWithMcp(mcpConnections);

		await expect(
			service.discoverProjectMcpConnectionTools({
				id: "mcp-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			ok: true,
			toolNames: ["create_issue", "list_issues"],
			source: "metadata",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it("lists connectable pieces through the piece catalog port", async () => {
		const pieceCatalog = fakePieceCatalog();
		const service = makeServiceWithPieceCatalog(pieceCatalog);

    await expect(
      service.listConnectablePieces({ authOnly: true }),
    ).resolves.toEqual([
			{
				name: "@activepieces/piece-github",
				displayName: "GitHub",
				logoUrl: "https://example.test/github.svg",
				authType: "OAUTH2",
			},
		]);
    expect(pieceCatalog.listConnectablePieces).toHaveBeenCalledWith({
      authOnly: true,
    });
	});

	it("composes catalog functions with code functions before ActivePieces functions", async () => {
		const pieceCatalog = fakePieceCatalog();
		const codeFunctionCatalog = fakeCodeFunctionCatalog();
		const service = makeServiceWithPieceCatalog(
			pieceCatalog,
			fakeMcpConnections(),
			fakeAppConnections(),
			codeFunctionCatalog,
		);

    await expect(
      service.listCatalogFunctions({ userId: "user-1" }),
    ).resolves.toEqual({
			functions: [
				{
					name: "summarize",
					version: "2",
					displayName: "Summarize",
					description: "Summarize text",
					pieceName: "code-functions",
					actionName: "main",
					sourceKind: "code",
					codeFunctionId: "code-1",
					language: "typescript",
				},
				{
					name: "github-create_issue",
					version: "1.0.0",
					displayName: "Create Issue",
					description: "Create a GitHub issue",
					pieceName: "github",
					actionName: "create_issue",
					providerId: "github",
					providerLabel: "GitHub",
					providerIconUrl: "https://example.test/github.svg",
					category: "developer-tools",
					entrypoint: "create_issue",
				},
			],
			count: 2,
			error: null,
		});
    expect(codeFunctionCatalog.listEnabledForCatalog).toHaveBeenCalledWith(
      "user-1",
    );
		expect(pieceCatalog.listPieceCatalogFunctions).toHaveBeenCalled();
	});

	it("preserves catalog partial failure and anonymous code-function omission", async () => {
		const pieceCatalog = {
			...fakePieceCatalog(),
			listPieceCatalogFunctions: vi.fn(async () => {
				throw new Error("catalog unavailable");
			}),
		} satisfies PieceCatalogRepository;
		const codeFunctionCatalog = fakeCodeFunctionCatalog();
		const service = makeServiceWithPieceCatalog(
			pieceCatalog,
			fakeMcpConnections(),
			fakeAppConnections(),
			codeFunctionCatalog,
		);

    await expect(
      service.listCatalogFunctions({ userId: null }),
    ).resolves.toEqual({
			functions: [],
			count: 0,
			error: "Error: catalog unavailable",
		});
		expect(codeFunctionCatalog.listEnabledForCatalog).not.toHaveBeenCalled();
	});

	it("loads MCP catalog piece actions through the piece catalog port", async () => {
		const pieceCatalog = {
			getLatestPieceMetadata: vi.fn(async () => ({
				name: "@activepieces/piece-github",
				displayName: "GitHub",
				description: null,
				logoUrl: null,
				categories: [],
				version: "1.0.0",
				auth: { type: "OAUTH2" },
				actions: {
					create_issue: {
						displayName: "Create Issue",
						description: "Open a new issue",
					},
					list_issues: {
						displayName: "List Issues",
					},
				},
				availableOnly: false,
				catalogSourceImage: null,
				catalogSyncedAt: null,
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
			listConnectablePieces: vi.fn(async () => []),
			listPieceCatalogFunctions: vi.fn(async () => []),
			listMcpCatalogPieces: vi.fn(async () => []),
			listConnectionUsageByPieceNames: vi.fn(async () => []),
		} satisfies PieceCatalogRepository;
		const service = makeServiceWithPieceCatalog(pieceCatalog);

		await expect(
			service.getMcpCatalogPieceActions("@activepieces/piece-github"),
		).resolves.toEqual({
			ok: true,
			pieceName: "github",
			actions: [
				{
					name: "create_issue",
					displayName: "Create Issue",
					description: "Open a new issue",
				},
				{
					name: "list_issues",
					displayName: "List Issues",
					description: null,
				},
			],
		});
		expect(pieceCatalog.getLatestPieceMetadata).toHaveBeenCalledWith([
			"github",
			"@activepieces/piece-github",
		]);
	});

	it("builds the workspace connection detail page read model", async () => {
		const pieceCatalog = {
			getLatestPieceMetadata: vi.fn(async () => ({
				name: "@activepieces/piece-github",
				displayName: "GitHub",
				description: "Source control",
				logoUrl: "https://example.test/github.svg",
				categories: ["developer-tools"],
				version: "1.0.0",
				auth: { type: "OAUTH2", displayName: "GitHub OAuth" },
				actions: {
					create_issue: {
						displayName: "Create Issue",
						description: "Open a new issue",
					},
				},
				availableOnly: false,
				catalogSourceImage: "ghcr.io/pieces/github:1.0.0",
				catalogSyncedAt: new Date("2026-01-02T00:00:00.000Z"),
				updatedAt: new Date("2026-01-03T00:00:00.000Z"),
			})),
			listConnectablePieces: vi.fn(async () => []),
			listPieceCatalogFunctions: vi.fn(async () => []),
			listMcpCatalogPieces: vi.fn(async () => []),
			listConnectionUsageByPieceNames: vi.fn(async () => [
				{
					connectionExternalId: "conn-ext-1",
					refCount: 2,
					workflowCount: 1,
				},
			]),
		} satisfies PieceCatalogRepository;
		const service = makeServiceWithPieceCatalog(pieceCatalog);

		await expect(
			service.getPieceConnectionDetailPage({
				pieceName: "@activepieces/piece-github",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			piece: {
				pieceName: "github",
				canonicalPieceName: "@activepieces/piece-github",
				displayName: "GitHub",
				description: "Source control",
				logoUrl: "https://example.test/github.svg",
				categories: ["developer-tools"],
				version: "1.0.0",
				authType: "OAUTH2",
				authDisplayName: "GitHub OAuth",
				requiresAuth: true,
				isOAuth2: true,
				availableOnly: false,
				catalogSourceImage: "ghcr.io/pieces/github:1.0.0",
				catalogSyncedAt: "2026-01-02T00:00:00.000Z",
				metadataUpdatedAt: "2026-01-03T00:00:00.000Z",
			},
			actions: [
				{
					name: "create_issue",
					displayName: "Create Issue",
					description: "Open a new issue",
				},
			],
			usageByConnection: {
				"conn-ext-1": {
					refCount: 2,
					workflowCount: 1,
				},
			},
		});
		expect(pieceCatalog.getLatestPieceMetadata).toHaveBeenCalledWith([
			"github",
			"@activepieces/piece-github",
		]);
		expect(pieceCatalog.listConnectionUsageByPieceNames).toHaveBeenCalledWith({
			pieceNameCandidates: ["github", "@activepieces/piece-github"],
			projectId: "project-1",
		});
	});

	it("composes MCP connection catalog entries through application ports", async () => {
		const pieceCatalog = {
			getLatestPieceMetadata: vi.fn(async () => null),
			listConnectablePieces: vi.fn(async () => []),
			listPieceCatalogFunctions: vi.fn(async () => []),
			listMcpCatalogPieces: vi.fn(async () => [
				{
					name: "@activepieces/piece-github",
					displayName: "GitHub",
					description: "Source control",
					logoUrl: "https://example.test/github.svg",
					categories: ["devtools"],
					auth: { type: "OAUTH2", displayName: "OAuth" },
					actions: { create_issue: {}, list_issues: {} },
					availableOnly: false,
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
				{
					name: "@activepieces/piece-slack",
					displayName: "Slack",
					description: "Chat",
					logoUrl: null,
					categories: ["communication"],
					auth: { type: "NONE" },
					actions: { send_message: {} },
					availableOnly: true,
					updatedAt: new Date("2026-01-02T00:00:00.000Z"),
				},
			]),
			listConnectionUsageByPieceNames: vi.fn(async () => []),
		} satisfies PieceCatalogRepository;
		const mcpConnections = {
			...fakeMcpConnections(),
			listProjectConnections: vi.fn(async () => [
				mcpConnection({
					id: "mcp-github",
					sourceType: "nimble_piece",
					pieceName: "github",
					connectionExternalId: "app-github",
					displayName: "GitHub MCP",
				}),
			]),
			listActiveAppConnectionCatalogSummaries: vi.fn(async () => [
				{
					id: "app-1",
					externalId: "app-github",
					displayName: "GitHub OAuth",
					pieceName: "@activepieces/piece-github",
					type: "OAUTH2",
					status: "ACTIVE",
				},
			]),
			listPlatformOAuthAppPieceNames: vi.fn(async () => [
				"@activepieces/piece-github",
			]),
		} satisfies McpConnectionRepository;
		const service = makeServiceWithPieceCatalog(pieceCatalog, mcpConnections);

		await expect(
			service.getMcpConnectionCatalog({
				projectId: "project-1",
				platformId: "platform-1",
				query: "github",
				configuredOnly: true,
			}),
		).resolves.toMatchObject({
			entries: [
				{
					pieceName: "github",
					canonicalPieceName: "@activepieces/piece-github",
					displayName: "GitHub",
					authType: "OAUTH2",
					authDisplayName: "OAuth",
					requiresAuth: true,
					isOAuth2: true,
					oauthAppConfigured: true,
					actionCount: 2,
					registryRef: "ap-github-service",
					serverUrl: "http://ap-github-service/mcp",
					availableOnly: false,
					appConnections: [
						{
							id: "app-1",
							externalId: "app-github",
							displayName: "GitHub OAuth",
						},
					],
					mcpConnection: {
						id: "mcp-github",
						connectionExternalId: "app-github",
					},
				},
			],
		});
		expect(mcpConnections.listPlatformOAuthAppPieceNames).toHaveBeenCalledWith({
			pieceNames: [
				"github",
				"@activepieces/piece-github",
				"slack",
				"@activepieces/piece-slack",
			],
			platformId: "platform-1",
			});
	});

	it("composes MCP availability through application ports", async () => {
		dynamicPrivateEnv.ACTIVEPIECES_MCP_CATALOG_JSON = JSON.stringify({
			github: {
				pieceName: "github",
				serviceName: "ap-github-service",
				serverUrl: "http://ap-github-service/mcp",
				categories: ["devtools"],
			},
		});
		const pieceCatalog = {
			getLatestPieceMetadata: vi.fn(async () => null),
			listConnectablePieces: vi.fn(async () => []),
			listPieceCatalogFunctions: vi.fn(async () => []),
			listMcpCatalogPieces: vi.fn(async () => [
				{
					name: "@activepieces/piece-github",
					displayName: "GitHub",
					description: "Source control",
					logoUrl: "https://example.test/github.svg",
					categories: ["devtools"],
					auth: { type: "OAUTH2", displayName: "OAuth" },
					actions: { create_issue: {} },
					availableOnly: false,
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			]),
			listConnectionUsageByPieceNames: vi.fn(async () => []),
		} satisfies PieceCatalogRepository;
		const mcpConnections = {
			...fakeMcpConnections(),
			listProjectConnections: vi.fn(async () => [
				mcpConnection({
					id: "mcp-github",
					sourceType: "nimble_piece",
					pieceName: "github",
					connectionExternalId: "app-github",
					displayName: "GitHub MCP",
				}),
				mcpConnection({
					id: "mcp-custom",
					sourceType: "custom_url",
					pieceName: null,
					serverKey: "custom",
					connectionExternalId: null,
					displayName: "Custom MCP",
					registryRef: null,
					serverUrl: "https://mcp.example.test/mcp",
				}),
			]),
			listActiveAppConnectionCatalogSummaries: vi.fn(async () => [
				{
					id: "app-1",
					externalId: "app-github",
					displayName: "GitHub OAuth",
					pieceName: "@activepieces/piece-github",
					type: "OAUTH2",
					status: "ACTIVE",
				},
			]),
			listPlatformOAuthAppPieceNames: vi.fn(async () => [
				"@activepieces/piece-github",
			]),
		} satisfies McpConnectionRepository;
		const service = makeServiceWithPieceCatalog(pieceCatalog, mcpConnections);

		await expect(
			service.getMcpAvailability({
				projectId: "project-1",
				platformId: "platform-1",
			}),
		).resolves.toMatchObject({
			source: { catalogPath: null, registeredCount: 1 },
			customConnections: [{ id: "mcp-custom", sourceType: "custom_url" }],
			entries: [
				{
					pieceName: "github",
					registered: true,
					enabled: true,
					ready: true,
					authStatus: "READY",
					oauthAppConfigured: true,
					selectedAppConnection: {
						id: "app-1",
						externalId: "app-github",
						displayName: "GitHub OAuth",
					},
					mcpConnection: {
						id: "mcp-github",
						connectionExternalId: "app-github",
					},
				},
			],
		});
		expect(pieceCatalog.listMcpCatalogPieces).toHaveBeenCalled();
    expect(mcpConnections.listProjectConnections).toHaveBeenCalledWith(
			"project-1",
		);
    expect(
      mcpConnections.listActiveAppConnectionCatalogSummaries,
    ).toHaveBeenCalledWith("project-1");
		expect(mcpConnections.listPlatformOAuthAppPieceNames).toHaveBeenCalledWith({
			pieceNames: ["github", "@activepieces/piece-github"],
			platformId: "platform-1",
		});
		delete dynamicPrivateEnv.ACTIVEPIECES_MCP_CATALOG_JSON;
	});

	it("returns a hosted MCP server read model and syncs the hosted connection through ports", async () => {
		const hostedMcpServers = {
			...fakeHostedMcpServers(),
			listWorkflowSourcesForProject: vi.fn(async () => [
				{
					id: "wf-mcp",
					name: "Generate summary",
					description: "Summarize a document",
					nodes: [
						{
							data: {
								type: "trigger",
								config: {
									triggerType: "MCP",
									enabled: "false",
									toolName: "generate_summary",
									toolDescription: "Generate a concise summary",
									inputSchema:
										'[{"name":"document","type":"string","required":true}]',
									returnsResponse: "true",
								},
							},
						},
					],
				},
			]),
			upsertHostedWorkflowConnection: vi.fn(async (input) =>
				mcpConnection({
					id: "hosted-mcp",
					projectId: input.projectId,
					sourceType: "hosted_workflow",
					pieceName: null,
					serverUrl: input.serverUrl ?? null,
					status: input.status,
					metadata: input.metadata ?? null,
				}),
			),
		} satisfies HostedMcpServerRepository;
		const workspaceProjects = {
			...fakeWorkspaceProjects(),
			getProjectMembershipDetail: vi.fn(async () => ({
				id: "project-1",
				displayName: "Project",
				externalId: "workspace-1",
				selfRole: "VIEWER" as const,
			})),
		} satisfies WorkspaceProjectRepository;
    const service = makeServiceWithHostedMcp(
      hostedMcpServers,
      workspaceProjects,
    );

		const result = await service.getProjectHostedMcpServer({
			projectId: "project-1",
			userId: "user-1",
			requestUrl: "https://app.example.test/workspaces/workspace-1",
		});

		expect(result).toMatchObject({
			ok: true,
			server: {
				id: "mcp-server-1",
				projectId: "project-1",
				status: "DISABLED",
				token: "hosted-token",
				flows: [
					{
						id: "wf-mcp",
						name: "Generate summary",
						enabled: false,
						trigger: {
							toolName: "generate_summary",
							toolDescription: "Generate a concise summary",
							inputSchema: [
								{ name: "document", type: "string", required: true },
							],
							returnsResponse: true,
						},
					},
				],
			},
		});
		expect(workspaceProjects.getProjectMembershipDetail).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
    expect(hostedMcpServers.listWorkflowSourcesForProject).toHaveBeenCalledWith(
      {
			projectId: "project-1",
			ownerId: "owner-1",
      },
    );
    expect(
      hostedMcpServers.upsertHostedWorkflowConnection,
    ).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				status: "DISABLED",
				serverUrl:
					"https://app.example.test/api/v1/projects/project-1/mcp-server/http",
				registryRef: "mcp-gateway",
				actorUserId: "user-1",
			}),
		);
	});

	it("rejects invalid hosted MCP status updates before touching server state", async () => {
		const hostedMcpServers = fakeHostedMcpServers();
		const service = makeServiceWithHostedMcp(hostedMcpServers);

		const result = await service.updateProjectHostedMcpServerStatus({
			projectId: "project-1",
			userId: "user-1",
			status: "BROKEN",
		});

		expect(result).toEqual({
			ok: false,
			status: 400,
			message: "Invalid status",
		});
		expect(hostedMcpServers.updateServerStatus).not.toHaveBeenCalled();
    expect(
      hostedMcpServers.upsertHostedWorkflowConnection,
    ).not.toHaveBeenCalled();
	});

	it("rotates hosted MCP tokens for project writers and syncs the hosted connection", async () => {
		const hostedMcpServers = fakeHostedMcpServers();
		const service = makeServiceWithHostedMcp(hostedMcpServers);

		const result = await service.rotateProjectHostedMcpServerToken({
			projectId: "project-1",
			userId: "user-1",
			requestUrl: "https://app.example.test/settings",
		});

		expect(result.ok).toBe(true);
    if (!result.ok)
      throw new Error("expected hosted MCP token rotation to succeed");
		expect(result.server.token).toMatch(/^[0-9a-z]{72}$/);
		expect(hostedMcpServers.updateServerToken).toHaveBeenCalledWith({
			id: "mcp-server-1",
			tokenEncrypted: {
				iv: "test-iv",
				data: expect.stringMatching(/^encrypted:[0-9a-z]{72}$/),
			},
		});
    expect(
      hostedMcpServers.upsertHostedWorkflowConnection,
    ).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				status: "DISABLED",
				serverUrl:
					"https://app.example.test/api/v1/projects/project-1/mcp-server/http",
			}),
		);
	});

	it("returns internal hosted MCP server bootstrap data without route-level DB access", async () => {
		const hostedMcpServers = fakeHostedMcpServers();
		const service = makeServiceWithHostedMcp(hostedMcpServers);

		const result = await service.getInternalHostedMcpServer({
			projectId: "project-1",
		});

		expect(result).toMatchObject({
			ok: true,
			server: {
				id: "mcp-server-1",
				projectId: "project-1",
				token: "hosted-token",
				flows: [],
			},
		});
    expect(hostedMcpServers.getProjectOwnerId).toHaveBeenCalledWith(
      "project-1",
    );
	});

	it("composes internal MCP gateway catalog through workflow-data ports", async () => {
		const hostedMcpServers = {
			...fakeHostedMcpServers(),
			getServerByProjectId: vi.fn(async () => ({
				id: "mcp-server-1",
				projectId: "project-1",
				status: "ENABLED" as const,
				tokenEncrypted: { iv: "test-iv", data: "encrypted:hosted-token" },
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
		} satisfies HostedMcpServerRepository;
		const mcpConnections = {
			...fakeMcpConnections(),
			listProjectConnections: vi.fn(async () => [
				mcpConnection({
					id: "hosted-connection",
					sourceType: "hosted_workflow",
					pieceName: null,
					serverKey: null,
					displayName: "Hosted Tools",
					registryRef: "mcp-gateway",
					serverUrl: null,
					status: "ENABLED",
					metadata: {
						transport: "streamable_http",
						endpointPath: "/api/v1/projects/:projectId/mcp-server/http",
					},
				}),
				mcpConnection({
					id: "disabled-connection",
					displayName: "Disabled",
					status: "DISABLED",
				}),
			]),
		} satisfies McpConnectionRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections,
			hostedMcpServers,
			mcpRuns: fakeMcpRuns(),
			appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		const result = await service.getInternalProjectMcpCatalog({
			projectRef: "workspace-1",
		});

		expect(result).toMatchObject({
			ok: true,
			catalog: {
				projectId: "project-1",
				projectExternalId: "workspace-1",
				servers: [
					{
						displayName: "Hosted Tools",
						sourceType: "hosted_workflow",
						url: "http://mcp-gateway.workflow-builder.svc.cluster.local:8080/api/v1/projects/project-1/mcp-server/http",
						headers: { Authorization: "Bearer hosted-token" },
					},
				],
			},
		});
    expect(
      hostedMcpServers.resolveProjectByIdOrExternalId,
    ).toHaveBeenCalledWith("workspace-1");
    expect(
      hostedMcpServers.upsertHostedWorkflowConnection,
    ).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				status: "ENABLED",
			}),
		);
    expect(mcpConnections.listProjectConnections).toHaveBeenCalledWith(
      "project-1",
    );
	});

	it("reads MCP runs through the MCP run repository", async () => {
		const mcpRuns = fakeMcpRuns();
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers: fakeHostedMcpServers(),
			mcpRuns,
			appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(service.getMcpRun("mcp-run-1")).resolves.toMatchObject({
			id: "mcp-run-1",
			status: "STARTED",
		});
		expect(mcpRuns.getRun).toHaveBeenCalledWith("mcp-run-1");
	});

	it("stores MCP run responses through the MCP run repository", async () => {
		const mcpRuns = fakeMcpRuns();
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers: fakeHostedMcpServers(),
			mcpRuns,
			appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.respondToMcpRun({
				runId: "mcp-run-1",
				response: { content: "done" },
			}),
		).resolves.toMatchObject({
			id: "mcp-run-1",
			status: "RESPONDED",
			response: { content: "done" },
		});
		expect(mcpRuns.respondToRun).toHaveBeenCalledWith({
			runId: "mcp-run-1",
			response: { content: "done" },
		});
	});

	it("starts hosted MCP workflow tools through workflow-data ports", async () => {
		const workflow = {
			...baseWorkflow,
			nodes: [
				{
					data: {
						type: "trigger",
						config: {
							triggerType: "MCP",
							enabled: true,
							toolName: "generate_summary",
							returnsResponse: true,
						},
					},
				},
			],
			spec: {
				document: {
					dsl: "1.0.0",
					namespace: "default",
					name: "generate-summary",
				},
			},
		} satisfies WorkflowDefinition;
		const { workflowDefinitions } = makeService({ byId: workflow });
		const hostedMcpServers = {
			...fakeHostedMcpServers(),
			getServerByProjectId: vi.fn(async () => ({
				id: "mcp-server-1",
				projectId: "project-1",
				status: "ENABLED" as const,
				tokenEncrypted: { iv: "test-iv", data: "encrypted:hosted-token" },
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
		} satisfies HostedMcpServerRepository;
		const mcpRuns = fakeMcpRuns();
		const workflowExecutions = fakeWorkflowExecutions();
		const workflowScheduler = fakeWorkflowScheduler();
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers,
			mcpRuns,
			appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
			workflowScheduler,
		});

		await expect(
			service.startHostedMcpWorkflowTool({
				projectId: "project-1",
				workflowId: "wf-id",
				input: { document: "hello" },
				traceHeaders: { traceparent: "00-trace" },
			}),
		).resolves.toEqual({
			ok: true,
			status: 200,
			runId: "mcp-run-1",
			executionId: "exec-1",
			instanceId: "sw-example-exec-exec-1",
			returnsResponse: true,
		});

		expect(workflowExecutions.assertReadModelReady).toHaveBeenCalledTimes(1);
		expect(mcpRuns.createRun).toHaveBeenCalledWith({
			projectId: "project-1",
			mcpServerId: "mcp-server-1",
			workflowId: "wf-id",
			toolName: "generate_summary",
			input: { document: "hello" },
		});
		expect(workflowExecutions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-id",
				userId: "user-1",
				projectId: "project-1",
				status: "running",
				phase: "running",
				progress: 0,
				executionIrVersion: "sw-1.0",
				input: expect.objectContaining({
					document: "hello",
					__mcp: expect.objectContaining({ runId: "mcp-run-1" }),
				}),
			}),
		);
		expect(workflowScheduler.startSwWorkflow).toHaveBeenCalledWith(
			expect.objectContaining({
				headers: {
					"Content-Type": "application/json",
					traceparent: "00-trace",
				},
				workflowId: "wf-id",
				dbExecutionId: "exec-1",
			}),
		);
		expect(workflowExecutions.attachSchedulerInstance).toHaveBeenCalledWith({
			executionId: "exec-1",
			instanceId: "sw-example-exec-exec-1",
			workflowSessionId: "exec-1",
		});
		expect(mcpRuns.attachExecution).toHaveBeenCalledWith({
			runId: "mcp-run-1",
			workflowExecutionId: "exec-1",
			daprInstanceId: "sw-example-exec-exec-1",
		});
	});

	it("marks hosted MCP workflow execution rows failed when scheduler dispatch fails", async () => {
		const workflow = {
			...baseWorkflow,
			nodes: [
				{
					data: {
						type: "trigger",
						config: {
							triggerType: "MCP",
							enabled: true,
							toolName: "generate_summary",
						},
					},
				},
			],
			spec: {
				document: {
					dsl: "1.0.0",
					namespace: "default",
					name: "generate-summary",
				},
			},
		} satisfies WorkflowDefinition;
		const { workflowDefinitions } = makeService({ byId: workflow });
		const hostedMcpServers = {
			...fakeHostedMcpServers(),
			getServerByProjectId: vi.fn(async () => ({
				id: "mcp-server-1",
				projectId: "project-1",
				status: "ENABLED" as const,
				tokenEncrypted: { iv: "test-iv", data: "encrypted:hosted-token" },
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
		} satisfies HostedMcpServerRepository;
		const mcpRuns = fakeMcpRuns();
		const workflowExecutions = fakeWorkflowExecutions();
		const workflowScheduler = {
			startSwWorkflow: vi.fn(async () => {
				throw new Error("orchestrator unavailable");
			}),
			startScriptWorkflow: vi.fn(async () => {
				throw new Error("orchestrator unavailable");
			}),
		} satisfies WorkflowScheduler;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers,
			mcpRuns,
			appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
			workflowScheduler,
		});

		await expect(
			service.startHostedMcpWorkflowTool({
				projectId: "project-1",
				workflowId: "wf-id",
				input: { document: "hello" },
			}),
		).resolves.toEqual({
			ok: false,
			status: 502,
			message: "SW workflow failed: orchestrator unavailable",
		});

		expect(workflowExecutions.applyRuntimeProjection).toHaveBeenCalledWith("exec-1", {
			status: "error",
			error: "orchestrator unavailable",
		});
		expect(workflowExecutions.attachSchedulerInstance).not.toHaveBeenCalled();
		expect(mcpRuns.attachExecution).not.toHaveBeenCalled();
	});

	it("rejects hosted MCP workflow starts when the scheduler omits an instance id", async () => {
		const workflow = {
			...baseWorkflow,
			nodes: [
				{
					data: {
						type: "trigger",
						config: {
							triggerType: "MCP",
							enabled: true,
							toolName: "generate_summary",
						},
					},
				},
			],
			spec: {
				document: {
					dsl: "1.0.0",
					namespace: "default",
					name: "generate-summary",
				},
			},
		} satisfies WorkflowDefinition;
		const { workflowDefinitions } = makeService({ byId: workflow });
		const hostedMcpServers = {
			...fakeHostedMcpServers(),
			getServerByProjectId: vi.fn(async () => ({
				id: "mcp-server-1",
				projectId: "project-1",
				status: "ENABLED" as const,
				tokenEncrypted: { iv: "test-iv", data: "encrypted:hosted-token" },
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
		} satisfies HostedMcpServerRepository;
		const mcpRuns = fakeMcpRuns();
		const workflowExecutions = fakeWorkflowExecutions();
		const workflowScheduler = {
			startSwWorkflow: vi.fn(async () => ({})),
			startScriptWorkflow: vi.fn(async () => ({})),
		} satisfies WorkflowScheduler;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers,
			mcpRuns,
			appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
			workflowScheduler,
		});

		await expect(
			service.startHostedMcpWorkflowTool({
				projectId: "project-1",
				workflowId: "wf-id",
				input: { document: "hello" },
			}),
		).resolves.toEqual({
			ok: false,
			status: 502,
			message: "SW workflow failed: missing instanceId",
		});

		expect(workflowExecutions.applyRuntimeProjection).toHaveBeenCalledWith("exec-1", {
			status: "error",
			error: "Orchestrator did not return an instanceId",
		});
		expect(workflowExecutions.attachSchedulerInstance).not.toHaveBeenCalled();
		expect(mcpRuns.attachExecution).not.toHaveBeenCalled();
	});

	it("lists project app connections through app-connection ports", async () => {
		const createdAt = new Date("2026-01-01T00:00:00.000Z");
		const updatedAt = new Date("2026-01-02T00:00:00.000Z");
		const appConnections = {
			...fakeAppConnections(),
			listProjectConnections: vi.fn(async () => [
				{
					id: "conn-row-1",
					externalId: "conn_github",
					pieceName: "@activepieces/piece-github",
					displayName: "GitHub Token",
					type: "SECRET_TEXT",
					status: "ACTIVE",
					scope: "PROJECT",
					ownerId: "user-1",
					platformId: null,
					projectIds: ["project-1"],
					createdAt,
					updatedAt,
				},
				{
					id: "conn-row-2",
					externalId: "conn_slack",
					pieceName: "@activepieces/piece-slack",
					displayName: "Slack OAuth",
					type: "OAUTH2",
					status: "MISSING",
					scope: "PROJECT",
					ownerId: "user-1",
					platformId: null,
					projectIds: ["project-1"],
					createdAt,
					updatedAt,
				},
			]),
			listPieceInfo: vi.fn(async () => [
				{
					name: "@activepieces/piece-github",
					displayName: "GitHub",
					logoUrl: "https://example.test/github.svg",
					categories: ["developer-tools"],
				},
				{
					name: "@activepieces/piece-slack",
					displayName: "Slack",
					logoUrl: null,
					categories: ["communication"],
				},
			]),
		} satisfies AppConnectionRepository;
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		await expect(
			service.listProjectAppConnections({
				projectId: "project-1",
				provider: "github",
				search: "token",
				status: "active",
			}),
		).resolves.toEqual([
			{
				id: "conn-row-1",
				externalId: "conn_github",
				pieceName: "@activepieces/piece-github",
				displayName: "GitHub Token",
				type: "SECRET_TEXT",
				status: "ACTIVE",
				scope: "PROJECT",
				ownerId: "user-1",
				platformId: null,
				createdAt,
				updatedAt,
				providerId: "github",
				providerLabel: "GitHub",
				providerIconUrl: "https://example.test/github.svg",
				category: "developer-tools",
			},
		]);
    expect(appConnections.listProjectConnections).toHaveBeenCalledWith(
      "project-1",
    );
		expect(appConnections.listPieceInfo).toHaveBeenCalledTimes(1);
	});

	it("creates app connections with encrypted values through the app-connection port", async () => {
		const appConnections = {
			...fakeAppConnections(),
			createConnection: vi.fn(async (input) => ({
				id: input.id,
				externalId: input.externalId,
				pieceName: input.pieceName,
				displayName: input.displayName,
				type: input.type,
				status: input.status,
				scope: input.scope,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
		} satisfies AppConnectionRepository;
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		const result = await service.createProjectAppConnection({
			projectId: "project-1",
			userId: "user-1",
			platformId: "platform-1",
			pieceName: "github",
			displayName: " GitHub Token ",
			type: "secret_text",
			value: "ghp_secret",
		});

		expect(result).toMatchObject({
			ok: true,
			connection: {
				pieceName: "github",
				displayName: "GitHub Token",
				type: "SECRET_TEXT",
				status: "ACTIVE",
				scope: "PROJECT",
			},
		});
		expect(appConnections.createConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				externalId: expect.stringMatching(/^conn_/),
				pieceName: "github",
				displayName: "GitHub Token",
				type: "SECRET_TEXT",
				status: "ACTIVE",
				value: {
					iv: "test-iv",
					data: 'encrypted:{"type":"SECRET_TEXT","secret_text":"ghp_secret"}',
				},
				pieceVersion: "0.0.0",
				projectIds: ["project-1"],
				ownerId: "user-1",
				platformId: "platform-1",
				scope: "PROJECT",
			}),
		);
	});

	it("validates app connection creation before calling the repository", async () => {
		const appConnections = fakeAppConnections();
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		await expect(
			service.createProjectAppConnection({
				projectId: "project-1",
				pieceName: "github",
				displayName: "GitHub Token",
				type: "SECRET_TEXT",
			}),
		).resolves.toEqual({
			ok: false,
			status: 400,
			message: "value is required for SECRET_TEXT connections",
		});
		expect(appConnections.createConnection).not.toHaveBeenCalled();
	});

	it("updates and deletes app connections through the app-connection port", async () => {
		const appConnections = {
			...fakeAppConnections(),
			updateDisplayName: vi.fn(async (input) => ({
				id: input.id,
				externalId: "conn_github",
				pieceName: "github",
				displayName: input.displayName,
				type: "SECRET_TEXT",
				status: "ACTIVE",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
			deleteProjectConnection: vi.fn(async () => true),
		} satisfies AppConnectionRepository;
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		await expect(
			service.updateProjectAppConnection({
				id: "conn-row-1",
				projectId: "project-1",
				displayName: " Renamed ",
			}),
		).resolves.toMatchObject({
			ok: true,
			connection: { id: "conn-row-1", displayName: "Renamed" },
		});
		expect(appConnections.updateDisplayName).toHaveBeenCalledWith({
			id: "conn-row-1",
			projectId: "project-1",
			displayName: "Renamed",
		});

		await expect(
			service.deleteProjectAppConnection({
				id: "conn-row-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({ ok: true });
		expect(appConnections.deleteProjectConnection).toHaveBeenCalledWith({
			id: "conn-row-1",
			projectId: "project-1",
		});
	});

	it("maps missing app connection updates and deletes to 404 results", async () => {
		const appConnections = {
			...fakeAppConnections(),
			updateDisplayName: vi.fn(async () => null),
			deleteProjectConnection: vi.fn(async () => false),
		} satisfies AppConnectionRepository;
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		await expect(
			service.updateProjectAppConnection({
				id: "missing",
				projectId: "project-1",
				displayName: "Missing",
			}),
		).resolves.toEqual({
			ok: false,
			status: 404,
			message: "Connection not found",
		});
		await expect(
			service.deleteProjectAppConnection({
				id: "missing",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			ok: false,
			status: 404,
			message: "Connection not found",
		});
	});

	it("starts app-connection OAuth through piece metadata and OAuth app ports", async () => {
		const appConnections = {
			...fakeAppConnections(),
			findOAuthPieceMetadata: vi.fn(async () => ({
				name: "@activepieces/piece-github",
				version: "1.0.0",
				auth: {
					type: "OAUTH2",
					authUrl: "https://github.example/authorize",
					tokenUrl: "https://github.example/token",
					scope: ["repo", "user:{tenant}"],
					pkce: true,
					pkceMethod: "S256",
					extra: { audience: "{tenant}" },
				},
			})),
			findPlatformOAuthApp: vi.fn(async () => ({
				pieceName: "@activepieces/piece-github",
				platformId: "platform-1",
				clientId: "client-1",
				clientSecret: { iv: "test-iv", data: "encrypted:secret-1" },
			})),
		} satisfies AppConnectionRepository;
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		const result = await service.startAppConnectionOAuth2({
			pieceName: "github",
			redirectUrl: "https://app.example/api/app-connections/oauth2/callback",
			props: { tenant: "acme" },
		});

		expect(result).toMatchObject({
			ok: true,
			clientId: "client-1",
			redirectUrl: "https://app.example/api/app-connections/oauth2/callback",
			scope: "repo user:acme",
		});
		if (result.ok) {
			const authorizationUrl = new URL(result.authorizationUrl);
			expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
				"https://github.example/authorize",
			);
			expect(authorizationUrl.searchParams.get("client_id")).toBe("client-1");
			expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
				"https://app.example/api/app-connections/oauth2/callback",
			);
			expect(authorizationUrl.searchParams.get("scope")).toBe("repo user:acme");
			expect(authorizationUrl.searchParams.get("audience")).toBe("acme");
			expect(result.codeVerifier).not.toEqual("");
			expect(result.codeChallenge).not.toEqual("");
		}
		expect(appConnections.findOAuthPieceMetadata).toHaveBeenCalledWith({
			pieceNameCandidates: ["github", "@activepieces/piece-github"],
			pieceVersion: null,
		});
	});

	it("completes app-connection OAuth and stores platform token values through ports", async () => {
    const fetchSpy = vi.fn(
      async () =>
			new Response(
				JSON.stringify({
					access_token: "access-1",
					refresh_token: "refresh-1",
					token_type: "bearer",
					expires_in: 3600,
					scope: "repo",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const appConnections = {
			...fakeAppConnections(),
			findConnectionById: vi.fn(async () => ({
				id: "conn-row-1",
				externalId: "conn_github",
				pieceName: "github",
				displayName: "GitHub",
				type: "OAUTH2",
				status: "MISSING",
				scope: "PROJECT",
				ownerId: "user-1",
				platformId: "platform-1",
				projectIds: [],
				pieceVersion: null,
				value: {
					iv: "test-iv",
					data: 'encrypted:{"redirect_url":"https://saved.example/callback","props":{"tenant":"acme"}}',
				},
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
			findOAuthPieceMetadata: vi.fn(async () => ({
				name: "@activepieces/piece-github",
				version: "1.2.3",
				auth: {
					type: "OAUTH2",
					authUrl: "https://github.example/authorize",
					tokenUrl: "https://github.example/{tenant}/token",
					scope: ["repo"],
					authorizationMethod: "BODY",
				},
			})),
			findPlatformOAuthApp: vi.fn(async () => ({
				pieceName: "@activepieces/piece-github",
				platformId: "platform-1",
				clientId: "client-1",
				clientSecret: { iv: "test-iv", data: "encrypted:secret-1" },
			})),
			updateOAuthConnection: vi.fn(async (input) => ({
				id: input.id,
				externalId: "conn_github",
				pieceName: input.pieceName,
				displayName: "GitHub",
				type: "PLATFORM_OAUTH2",
				status: "ACTIVE",
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-02T00:00:00.000Z"),
			})),
		} satisfies AppConnectionRepository;
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		await expect(
			service.completeAppConnectionOAuth2({
				projectId: "project-1",
				connectionId: "conn-row-1",
				pieceName: "github",
				code: "code-1",
        defaultRedirectUrl:
          "https://app.example/api/app-connections/oauth2/callback",
			}),
		).resolves.toMatchObject({
			ok: true,
			connection: {
				id: "conn-row-1",
				type: "PLATFORM_OAUTH2",
				status: "ACTIVE",
			},
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://github.example/acme/token",
			expect.objectContaining({ method: "POST" }),
		);
		expect(appConnections.updateOAuthConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "conn-row-1",
				pieceName: "github",
				pieceVersion: "1.2.3",
				projectIds: ["project-1"],
				value: expect.objectContaining({
					iv: "test-iv",
					data: expect.stringContaining('"type":"PLATFORM_OAUTH2"'),
				}),
			}),
		);
		vi.unstubAllGlobals();
	});

	it("decrypts and refreshes app connection values through app-connection ports", async () => {
    const fetchSpy = vi.fn(
      async () =>
			new Response(
				JSON.stringify({
					access_token: "new-access",
					refresh_token: "new-refresh",
					token_type: "bearer",
					expires_in: 7200,
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const appConnections = {
			...fakeAppConnections(),
			findConnectionByExternalId: vi.fn(async () => ({
				id: "conn-row-1",
				externalId: "conn_github",
				pieceName: "github",
				displayName: "GitHub",
				type: "PLATFORM_OAUTH2",
				status: "ACTIVE",
				scope: "PROJECT",
				ownerId: "user-1",
				platformId: "platform-1",
				projectIds: ["project-1"],
				pieceVersion: "1.2.3",
				value: {
					iv: "test-iv",
          data: 'encrypted:{"type":"PLATFORM_OAUTH2","access_token":"old-access","refresh_token":"refresh-1","token_url":"https://github.example/token","client_id":"client-1","claimed_at":1,"expires_in":1}',
				},
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			})),
			findPlatformOAuthApp: vi.fn(async () => ({
				pieceName: "@activepieces/piece-github",
				platformId: "platform-1",
				clientId: "client-1",
				clientSecret: { iv: "test-iv", data: "encrypted:secret-1" },
			})),
			updateEncryptedValue: vi.fn(async () => undefined),
		} satisfies AppConnectionRepository;
		const service = makeServiceWithPieceCatalog(
			fakePieceCatalog(),
			fakeMcpConnections(),
			appConnections,
		);

		const result = await service.decryptAppConnectionValue({
			externalId: "conn_github",
		});

		expect(result).toMatchObject({
			ok: true,
			connection: {
				externalId: "conn_github",
				pieceName: "github",
				value: {
					access_token: "new-access",
					refresh_token: "new-refresh",
					client_secret: "secret-1",
				},
			},
		});
    if (result.ok)
      expect(result.connection.value.expiry_date).toEqual(expect.any(Number));
		expect(appConnections.updateEncryptedValue).toHaveBeenCalledWith({
			id: "conn-row-1",
			value: expect.objectContaining({
				iv: "test-iv",
				data: expect.stringContaining('"access_token":"new-access"'),
			}),
		});
		vi.unstubAllGlobals();
	});

	it("composes admin piece enablement read models and delegates toggles", async () => {
		const adminPieces = {
			listCatalogPieces: vi.fn(async ({ availableOnly }) =>
				availableOnly
					? [
							{
								name: "slack",
								displayName: "Slack",
								logoUrl: "https://example.test/slack.svg",
							},
							{
								name: "custom-tool",
								displayName: "Custom Tool",
								logoUrl: "https://example.test/custom.svg",
							},
						]
					: [
							{
								name: "github",
								displayName: "GitHub",
								logoUrl: "https://example.test/github.svg",
							},
						],
			),
			listDisabledPieceNames: vi.fn(async () => ["github"]),
			listWorkflowReferencedPieceNames: vi.fn(async () => ["github"]),
			listEnabledMcpPieceNames: vi.fn(async () => []),
			listLatestImageStatuses: vi.fn(async () => [
				{
					pieceName: "slack",
					status: "ready",
					image: "ghcr.io/example/slack",
					errorMessage: null,
					enabled: true,
				},
				{
					pieceName: "custom-tool",
					status: "failed",
					image: null,
					errorMessage: "build failed",
					enabled: false,
				},
			]),
			getLatestCatalogPieceVersion: vi.fn(async () => "1.0.0"),
			setPieceEnabled: vi.fn(async () => undefined),
			markPieceImageBuilding: vi.fn(async () => undefined),
			markPieceImageReadyEnabled: vi.fn(async () => undefined),
			recordPieceImageResult: vi.fn(async () => null),
			listBuildingPieceImages: vi.fn(async () => []),
			markPieceRunnable: vi.fn(async () => undefined),
		} satisfies AdminPieceRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces,
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(service.getAdminPiecesReadModel()).resolves.toMatchObject({
			pieces: [
				{
					name: "github",
					displayName: "GitHub",
					enabled: false,
					inUse: true,
					pinned: true,
					perPiece: false,
				},
				{
					name: "slack",
					displayName: "Slack",
					enabled: true,
					inUse: false,
					pinned: false,
					perPiece: true,
				},
			],
			available: [
				{
					name: "custom-tool",
					displayName: "Custom Tool",
					buildStatus: "failed",
					errorMessage: "build failed",
				},
			],
			total: 2,
			enabledCount: 1,
			availableCount: 1,
		});
		await service.setAdminPieceEnabled({
			pieceName: "github",
			enabled: true,
			disabledBy: "user-1",
		});
		expect(adminPieces.setPieceEnabled).toHaveBeenCalledWith({
			pieceName: "github",
			enabled: true,
			disabledBy: "user-1",
		});
	});

	it("enables an admin piece runtime image immediately when the image already exists", async () => {
		const adminPieces = fakeAdminPieces();
		adminPieces.getLatestCatalogPieceVersion = vi.fn(async () => "2.1.0");
		const registry = {
			imageExists: vi.fn(async () => ({ exists: true, digest: "sha256:abc" })),
			imageRef: vi.fn(() => "ghcr.io/example/ap-piece-slack:2.1.0"),
		};
		const builds = {
			triggerBuild: vi.fn(async () => ({ triggered: true })),
		};
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers: fakeHostedMcpServers(),
			mcpRuns: fakeMcpRuns(),
			appConnections: fakeAppConnections(),
			adminPieces,
			adminPieceRuntimeImages: registry,
			adminPieceRuntimeImageBuilds: builds,
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.enableAdminPieceRuntimeImage({
				pieceName: "slack",
        callbackUrl:
          "https://workflow-builder-dev.example.test/api/internal/pieces/slack/image-registration",
			}),
		).resolves.toEqual({
			pieceName: "slack",
			version: "2.1.0",
			status: "ready",
			image: "ghcr.io/example/ap-piece-slack:2.1.0",
			digest: "sha256:abc",
			madeRunnable: true,
		});
		expect(adminPieces.markPieceImageReadyEnabled).toHaveBeenCalledWith({
			pieceName: "slack",
			version: "2.1.0",
			image: "ghcr.io/example/ap-piece-slack:2.1.0",
			digest: "sha256:abc",
		});
		expect(adminPieces.markPieceRunnable).toHaveBeenCalledWith("slack");
		expect(adminPieces.markPieceImageBuilding).not.toHaveBeenCalled();
		expect(builds.triggerBuild).not.toHaveBeenCalled();
	});

	it("records building and triggers the admin piece image build when the image is missing", async () => {
		const adminPieces = fakeAdminPieces();
		adminPieces.getLatestCatalogPieceVersion = vi.fn(async () => "3.0.0");
		const registry = {
			imageExists: vi.fn(async () => ({ exists: false })),
			imageRef: vi.fn(() => "ghcr.io/example/ap-piece-custom-tool:3.0.0"),
		};
		const builds = {
      triggerBuild: vi.fn(async () => ({
        triggered: false,
        reason: "not configured",
      })),
		};
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers: fakeHostedMcpServers(),
			mcpRuns: fakeMcpRuns(),
			appConnections: fakeAppConnections(),
			adminPieces,
			adminPieceRuntimeImages: registry,
			adminPieceRuntimeImageBuilds: builds,
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.enableAdminPieceRuntimeImage({
				pieceName: "custom-tool",
        callbackUrl:
          "https://workflow-builder-dev.example.test/api/internal/pieces/custom-tool/image-registration",
			}),
		).resolves.toEqual({
			pieceName: "custom-tool",
			version: "3.0.0",
			status: "building",
			madeRunnable: false,
			build: { triggered: false, reason: "not configured" },
		});
		expect(adminPieces.markPieceImageBuilding).toHaveBeenCalledWith({
			pieceName: "custom-tool",
			version: "3.0.0",
		});
		expect(builds.triggerBuild).toHaveBeenCalledWith({
			pieceName: "custom-tool",
			pieceVersion: "3.0.0",
			callbackUrl:
				"https://workflow-builder-dev.example.test/api/internal/pieces/custom-tool/image-registration",
		});
		expect(adminPieces.markPieceRunnable).not.toHaveBeenCalled();
	});

	it("records admin piece image callback results and makes enabled ready pieces runnable", async () => {
		const adminPieces = fakeAdminPieces();
		adminPieces.recordPieceImageResult = vi.fn(async () => ({
			enabledAt: new Date("2026-07-03T00:00:00.000Z"),
		}));
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers: fakeHostedMcpServers(),
			mcpRuns: fakeMcpRuns(),
			appConnections: fakeAppConnections(),
			adminPieces,
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.recordAdminPieceRuntimeImageResult({
				pieceName: "custom-tool",
				version: "3.0.0",
				status: "ready",
				image: "ghcr.io/example/ap-piece-custom-tool:3.0.0",
				digest: "sha256:def",
			}),
		).resolves.toEqual({
			pieceName: "custom-tool",
			version: "3.0.0",
			status: "ready",
			madeRunnable: true,
		});
		expect(adminPieces.recordPieceImageResult).toHaveBeenCalledWith({
			pieceName: "custom-tool",
			version: "3.0.0",
			status: "ready",
			image: "ghcr.io/example/ap-piece-custom-tool:3.0.0",
			digest: "sha256:def",
			errorMessage: null,
		});
		expect(adminPieces.markPieceRunnable).toHaveBeenCalledWith("custom-tool");
	});

	it("reconciles admin piece building rows through repository and registry ports", async () => {
		const adminPieces = fakeAdminPieces();
		const now = Date.now();
		adminPieces.listBuildingPieceImages = vi.fn(async () => [
			{
				pieceName: "ready-piece",
				version: "1.0.0",
				updatedAt: new Date(now),
				enabledAt: new Date("2026-07-03T00:00:00.000Z"),
			},
			{
				pieceName: "stale-piece",
				version: "2.0.0",
				updatedAt: new Date(now - 10_000),
				enabledAt: null,
			},
		]);
		adminPieces.recordPieceImageResult = vi.fn(async (input) => ({
			enabledAt: input.pieceName === "ready-piece" ? new Date() : null,
		}));
		const registry = {
			imageExists: vi.fn(async (input: { pieceName: string }) => ({
				exists: input.pieceName === "ready-piece",
				digest: input.pieceName === "ready-piece" ? "sha256:ready" : undefined,
			})),
			imageRef: vi.fn(
				(input: { pieceName: string; version: string }) =>
					`ghcr.io/example/ap-piece-${input.pieceName}:${input.version}`,
			),
		};
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers: fakeHostedMcpServers(),
			mcpRuns: fakeMcpRuns(),
			appConnections: fakeAppConnections(),
			adminPieces,
			adminPieceRuntimeImages: registry,
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.reconcileAdminPieceRuntimeImages({ buildTimeoutMs: 1000 }),
		).resolves.toEqual({ checked: 2, readied: 1, failed: 1 });
		expect(adminPieces.recordPieceImageResult).toHaveBeenCalledWith({
			pieceName: "ready-piece",
			version: "1.0.0",
			status: "ready",
			image: "ghcr.io/example/ap-piece-ready-piece:1.0.0",
			digest: "sha256:ready",
		});
		expect(adminPieces.recordPieceImageResult).toHaveBeenCalledWith({
			pieceName: "stale-piece",
			version: "2.0.0",
			status: "failed",
			errorMessage: "build did not produce a GHCR image within the timeout",
		});
		expect(adminPieces.markPieceRunnable).toHaveBeenCalledWith("ready-piece");
	});

	it("rejects unknown or invalid admin piece runtime image enablement requests", async () => {
		const adminPieces = fakeAdminPieces();
		adminPieces.getLatestCatalogPieceVersion = vi.fn(async () => null);
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
			mcpConnections: fakeMcpConnections(),
			hostedMcpServers: fakeHostedMcpServers(),
			mcpRuns: fakeMcpRuns(),
			appConnections: fakeAppConnections(),
			adminPieces,
			adminPieceRuntimeImages: {
				imageExists: vi.fn(async () => ({ exists: false })),
				imageRef: vi.fn(() => "unused"),
			},
			adminPieceRuntimeImageBuilds: {
				triggerBuild: vi.fn(async () => ({ triggered: true })),
			},
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.enableAdminPieceRuntimeImage({
				pieceName: "../bad",
				callbackUrl: "https://example.test/callback",
			}),
		).rejects.toThrow("invalid piece name");
		await expect(
			service.enableAdminPieceRuntimeImage({
				pieceName: "missing-piece",
				callbackUrl: "https://example.test/callback",
			}),
		).rejects.toThrow("piece 'missing-piece' is not in the catalog");
		expect(adminPieces.markPieceImageBuilding).not.toHaveBeenCalled();
	});

	it("resolves workspace project membership through the workspace project port", async () => {
		const workspaceProjects = {
			...fakeWorkspaceProjects(),
      getMemberProjectId: vi.fn(
        async (): Promise<string | null> => "project-current",
      ),
			getFallbackMemberProjectId: vi.fn(async () => "project-fallback"),
			getMemberProjectIdBySlug: vi.fn(async () => "project-slug"),
			getProjectExternalId: vi.fn(async () => "workspace-slug"),
			getProjectMembershipDetail: vi.fn(async () => ({
				id: "project-1",
				displayName: "Project One",
				externalId: "workspace-slug",
				selfRole: "ADMIN",
			})),
		} satisfies WorkspaceProjectRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects,
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.resolveWorkspaceProjectId({
				slug: "default",
				userId: "user-1",
				currentProjectId: "project-1",
			}),
		).resolves.toBe("project-current");
		await expect(
			service.resolveWorkspaceProjectId({
				slug: "workspace-slug",
				userId: "user-1",
				currentProjectId: "project-1",
			}),
		).resolves.toBe("project-slug");
    await expect(
      service.getWorkspaceProjectExternalId("project-1"),
    ).resolves.toBe("workspace-slug");
		await expect(
			service.getWorkspaceProjectMembershipDetail({
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toEqual({
			id: "project-1",
			displayName: "Project One",
			externalId: "workspace-slug",
			selfRole: "ADMIN",
		});
		await expect(
			service.resolveSessionProjectId({
				userId: "user-1",
				currentProjectId: "project-1",
			}),
		).resolves.toBe("project-current");

		expect(workspaceProjects.getMemberProjectId).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
		expect(workspaceProjects.getMemberProjectIdBySlug).toHaveBeenCalledWith({
			slug: "workspace-slug",
			userId: "user-1",
		});
    expect(workspaceProjects.getProjectExternalId).toHaveBeenCalledWith(
      "project-1",
    );
		expect(workspaceProjects.getProjectMembershipDetail).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
		expect(workspaceProjects.getFallbackMemberProjectId).not.toHaveBeenCalled();
		workspaceProjects.getMemberProjectId.mockResolvedValueOnce(null);
		await expect(
			service.resolveSessionProjectId({
				userId: "user-1",
				currentProjectId: "stale-project",
			}),
		).resolves.toBe("project-fallback");
    expect(workspaceProjects.getFallbackMemberProjectId).toHaveBeenCalledWith(
      "user-1",
    );
	});

	it("lists and creates workspaces through workspace project ports", async () => {
		const createdAt = new Date("2026-06-01T12:00:00.000Z");
		const workspaceProjects = {
			...fakeWorkspaceProjects(),
			listWorkspaceMemberships: vi.fn(async () => [
				{
					id: "project-1",
					displayName: "Current Workspace",
					externalId: "current-workspace",
					role: "ADMIN" as const,
					createdAt,
				},
				{
					id: "project-2",
					displayName: "Research Workspace",
					externalId: "research-workspace",
					role: "VIEWER" as const,
					createdAt,
				},
			]),
			createWorkspaceProject: vi.fn(async (input) => ({
				id: "project-created",
				displayName: input.displayName,
				externalId: input.externalId,
				role: "ADMIN" as const,
				createdAt,
			})),
		} satisfies WorkspaceProjectRepository;
		const service = makeServiceWithWorkspaceProjects(workspaceProjects);

		await expect(
			service.listWorkspaces({
				userId: "user-1",
				currentProjectId: "project-1",
			}),
		).resolves.toEqual([
			{
				id: "project-1",
				displayName: "Current Workspace",
				externalId: "current-workspace",
				slug: "default",
				role: "ADMIN",
				isCurrent: true,
				createdAt: "2026-06-01T12:00:00.000Z",
			},
			{
				id: "project-2",
				displayName: "Research Workspace",
				externalId: "research-workspace",
				slug: "research-workspace",
				role: "VIEWER",
				isCurrent: false,
				createdAt: "2026-06-01T12:00:00.000Z",
			},
		]);

		await expect(
			service.createWorkspace({
				displayName: "Research Workspace",
				externalId: "research-workspace",
				userId: "user-1",
				platformId: "platform-1",
			}),
		).resolves.toEqual({
			id: "project-created",
			displayName: "Research Workspace",
			externalId: "research-workspace",
			slug: "research-workspace",
			role: "ADMIN",
			isCurrent: false,
			createdAt: "2026-06-01T12:00:00.000Z",
		});

		expect(workspaceProjects.listWorkspaceMemberships).toHaveBeenCalledWith({
			userId: "user-1",
		});
		expect(workspaceProjects.createWorkspaceProject).toHaveBeenCalledWith({
			platformId: "platform-1",
			ownerId: "user-1",
			displayName: "Research Workspace",
			externalId: "research-workspace",
		});
	});

	it("renames workspaces only for project admins through workspace project ports", async () => {
		const workspaceProjects = {
			...fakeWorkspaceProjects(),
			getProjectMemberRole: vi.fn<
				WorkspaceProjectRepository["getProjectMemberRole"]
			>(async () => "VIEWER" as const),
			updateWorkspaceDisplayName: vi.fn(async () => true),
		} satisfies WorkspaceProjectRepository;
		const service = makeServiceWithWorkspaceProjects(workspaceProjects);

		await expect(
			service.renameWorkspace({
				projectId: "project-1",
				userId: "user-1",
				displayName: "Denied Rename",
			}),
		).resolves.toBe(false);
		expect(workspaceProjects.updateWorkspaceDisplayName).not.toHaveBeenCalled();

		workspaceProjects.getProjectMemberRole.mockResolvedValueOnce("ADMIN");
		await expect(
			service.renameWorkspace({
				projectId: "project-1",
				userId: "user-1",
				displayName: "Approved Rename",
			}),
		).resolves.toBe(true);

		expect(workspaceProjects.getProjectMemberRole).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
		expect(workspaceProjects.updateWorkspaceDisplayName).toHaveBeenCalledWith({
			projectId: "project-1",
			displayName: "Approved Rename",
		});
	});

	it("resolves execution workspace routes through the workflow execution port", async () => {
		const workflowExecutions = fakeWorkflowExecutions();
		const { service } = makeService({ workflowExecutions });

    await expect(service.getExecutionWorkspaceRoute("exec-1")).resolves.toEqual(
      {
			projectId: "project-1",
			userId: "user-1",
			workspaceSlug: "workspace-1",
      },
    );
		expect(workflowExecutions.getExecutionWorkspaceRoute).toHaveBeenCalledWith(
			"exec-1",
		);
	});

	it("lists project members for existing project members through workspace project ports", async () => {
		const workspaceProjects = fakeWorkspaceProjects();
		const service = makeServiceWithWorkspaceProjects(workspaceProjects);

		await expect(
			service.listProjectMembers({
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toMatchObject({
			ok: true,
			status: 200,
			selfRole: "ADMIN",
			members: [
				{
					id: "member-1",
					userId: "user-1",
					role: "ADMIN",
				},
			],
		});
		expect(workspaceProjects.getProjectMemberRole).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
    expect(workspaceProjects.listProjectMembers).toHaveBeenCalledWith(
      "project-1",
    );
	});

	it("adds existing platform users to a project and defaults role to viewer", async () => {
		const workspaceProjects = fakeWorkspaceProjects();
		const service = makeServiceWithWorkspaceProjects(workspaceProjects);

		await expect(
			service.addProjectMember({
				projectId: "project-1",
				userId: "admin-1",
				email: "ADA@example.test ",
			}),
		).resolves.toMatchObject({
			ok: true,
			status: 201,
			member: {
				projectId: "project-1",
				userId: "user-2",
				role: "VIEWER",
			},
		});

		expect(workspaceProjects.findPlatformUserForProject).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: null,
			email: "ada@example.test",
		});
		expect(workspaceProjects.addProjectMember).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-2",
			role: "VIEWER",
		});
	});

	it("blocks duplicate and cross-platform project member adds", async () => {
		const duplicateProjects = {
			...fakeWorkspaceProjects(),
			projectMemberExists: vi.fn(async () => true),
		} satisfies WorkspaceProjectRepository;
    const duplicateService =
      makeServiceWithWorkspaceProjects(duplicateProjects);
		await expect(
			duplicateService.addProjectMember({
				projectId: "project-1",
				userId: "admin-1",
				targetUserId: "user-2",
			}),
		).resolves.toEqual({
			ok: false,
			status: 409,
			message: "User is already a member",
		});
		expect(duplicateProjects.addProjectMember).not.toHaveBeenCalled();

		const crossPlatformProjects = {
			...fakeWorkspaceProjects(),
			findPlatformUserForProject: vi.fn(async () => ({
				ok: false as const,
				reason: "different_platform" as const,
			})),
		} satisfies WorkspaceProjectRepository;
    const crossPlatformService = makeServiceWithWorkspaceProjects(
      crossPlatformProjects,
    );
		await expect(
			crossPlatformService.addProjectMember({
				projectId: "project-1",
				userId: "admin-1",
				email: "other@example.test",
			}),
		).resolves.toEqual({
			ok: false,
			status: 403,
			message: "User is not part of this platform",
		});
		expect(crossPlatformProjects.addProjectMember).not.toHaveBeenCalled();
	});

	it("returns user-specific not-found messages for project member adds", async () => {
		const missingUserProjects = {
			...fakeWorkspaceProjects(),
			findPlatformUserForProject: vi.fn(async () => ({
				ok: false as const,
				reason: "user_not_found" as const,
			})),
		} satisfies WorkspaceProjectRepository;
		const service = makeServiceWithWorkspaceProjects(missingUserProjects);

		await expect(
			service.addProjectMember({
				projectId: "project-1",
				userId: "admin-1",
				targetUserId: "missing-user",
			}),
		).resolves.toEqual({
			ok: false,
			status: 404,
			message: "User not found",
		});

		await expect(
			service.addProjectMember({
				projectId: "project-1",
				userId: "admin-1",
				email: "missing@example.test",
			}),
		).resolves.toEqual({
			ok: false,
			status: 404,
			message: "No user with that email. Ask them to sign up first.",
		});
		expect(missingUserProjects.addProjectMember).not.toHaveBeenCalled();
	});

	it("blocks project member mutations unless the caller is an admin", async () => {
		const workspaceProjects = {
			...fakeWorkspaceProjects(),
			getProjectMemberRole: vi.fn(async () => "VIEWER" as const),
		} satisfies WorkspaceProjectRepository;
		const service = makeServiceWithWorkspaceProjects(workspaceProjects);

		await expect(
			service.updateProjectMemberRole({
				projectId: "project-1",
				memberId: "member-1",
				userId: "viewer-1",
				role: "EDITOR",
			}),
		).resolves.toEqual({
			ok: false,
			status: 403,
			message: "Forbidden",
		});
		expect(workspaceProjects.updateProjectMemberRole).not.toHaveBeenCalled();
	});

	it("preserves last-admin guards when updating and deleting project members", async () => {
		const workspaceProjects = {
			...fakeWorkspaceProjects(),
			countProjectAdmins: vi.fn(async () => 1),
		} satisfies WorkspaceProjectRepository;
		const service = makeServiceWithWorkspaceProjects(workspaceProjects);

		await expect(
			service.updateProjectMemberRole({
				projectId: "project-1",
				memberId: "member-1",
				userId: "admin-1",
				role: "EDITOR",
			}),
		).resolves.toEqual({
			ok: false,
			status: 400,
			message: "Cannot demote the last admin",
		});
		expect(workspaceProjects.updateProjectMemberRole).not.toHaveBeenCalled();

		await expect(
			service.deleteProjectMember({
				projectId: "project-1",
				memberId: "member-1",
				userId: "admin-1",
			}),
		).resolves.toEqual({
			ok: false,
			status: 400,
			message: "Cannot remove the last admin",
		});
		expect(workspaceProjects.deleteProjectMember).not.toHaveBeenCalled();
	});

	it("returns usage analytics through usage reporting ports with application-owned defaults", async () => {
		const usageReporting = fakeUsageReporting();
		const service = makeServiceWithUsageReporting(usageReporting);
		const now = new Date("2026-07-15T12:00:00.000Z");
		const expectedStart = new Date(now.getFullYear(), now.getMonth(), 1);

		await expect(
			service.getUsageAnalytics({
				userId: "user-1",
				projectId: "project-1",
				groupBy: "agent",
				now,
			}),
		).resolves.toEqual({
			range: { start: expectedStart.toISOString(), end: now.toISOString() },
			groupBy: "agent",
			totals: {
				tokensIn: 1000,
				tokensOut: 250,
				cacheReadTokens: 100,
				cacheCreateTokens: 50,
				sessionCount: 3,
				toolCalls: 2,
			},
			daily: [{ day: "2026-07-01", tokensIn: 1000, tokensOut: 250 }],
			byAgent: [
				{
					agentId: "agent-1",
					agentName: "Agent One",
					tokensIn: 1000,
					tokensOut: 250,
					sessions: 3,
				},
			],
		});
		expect(usageReporting.getUsageAnalytics).toHaveBeenCalledWith({
			scope: { userId: "user-1", projectId: "project-1" },
			start: expectedStart,
			end: now,
		});
	});

	it("computes cost breakdowns in workflow-data and resolves provider-prefixed model ids", async () => {
		const usageReporting = fakeUsageReporting();
		const service = makeServiceWithUsageReporting(usageReporting);
		const now = new Date("2026-07-15T12:00:00.000Z");
		const start = "2026-07-01T00:00:00.000Z";
		const end = "2026-07-02T00:00:00.000Z";

		const result = await service.getCostBreakdown({
			userId: "user-1",
			start,
			end,
			now,
		});

		expect(result.range).toEqual({ start, end });
		expect(result.totalCost).toBeCloseTo(9);
		expect(result.byAgent).toEqual([
			{
				agentId: "agent-1",
				agentName: "Agent One",
				sessions: 2,
				cost: 9,
			},
		]);
		expect(result.byModel).toEqual([
			{
				model: "anthropic/claude-opus-4-8",
				sessions: 2,
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				cost: 9,
			},
		]);
    expect(
      result.priceBook.some((row) => row.model === "claude-opus-4-8"),
    ).toBe(true);
		expect(usageReporting.listCostUsageRows).toHaveBeenCalledWith({
			scope: { userId: "user-1", projectId: undefined },
			start: new Date(start),
			end: new Date(end),
		});
	});

	it("returns live limit snapshots through usage reporting ports", async () => {
		const usageReporting = fakeUsageReporting();
		const service = makeServiceWithUsageReporting(usageReporting);
		const now = new Date("2026-07-15T12:00:00.000Z");

		await expect(
			service.getLiveLimitSnapshot({
				userId: "user-1",
				projectId: "project-1",
				now,
			}),
		).resolves.toEqual({
			activeSessions: 1,
			asOf: now.toISOString(),
			byModel: [
				{
					model: "claude-opus-4-8",
					sessionsLastHour: 2,
					tokensInLastHour: 1000,
					tokensOutLastHour: 250,
					tokensInLastMinute: 100,
					tokensOutLastMinute: 25,
				},
			],
		});
		expect(usageReporting.getLiveLimitSnapshot).toHaveBeenCalledWith({
			scope: { userId: "user-1", projectId: "project-1" },
			now,
		});
	});

	it("lists recent sandbox executions through sandbox inventory ports", async () => {
		const sandboxInventory = fakeSandboxInventory();
		const service = makeServiceWithSandboxInventory(sandboxInventory);

    await expect(
      service.listSandboxExecutions("dapr-agent-py"),
    ).resolves.toEqual([
			{
				executionId: "exec-1",
				workflowId: "wf-1",
				workflowName: "Unknown",
				status: "completed",
				startedAt: "2026-07-01T00:00:00.000Z",
				completedAt: null,
			},
		]);
    expect(
      sandboxInventory.listRecentExecutionsForSandbox,
    ).toHaveBeenCalledWith("dapr-agent-py");
	});

	it("lists sandbox session owners through session ports", async () => {
		const sessions = {
			...fakeSessions(),
			listSandboxSessionOwners: vi.fn(async () => [
				{
					sandboxName: "sandbox-1",
					id: "session-1",
					title: "Solve task",
					status: "running",
					workspaceSlug: "workspace-1",
				},
			]),
		} satisfies SessionRepository;
		const { service } = makeService({ sessions });

		await expect(
			service.listSandboxSessionOwners({ sandboxNames: ["sandbox-1"] }),
		).resolves.toEqual([
			{
				sandboxName: "sandbox-1",
				id: "session-1",
				title: "Solve task",
				status: "running",
				workspaceSlug: "workspace-1",
			},
		]);
		expect(sessions.listSandboxSessionOwners).toHaveBeenCalledWith({
			sandboxNames: ["sandbox-1"],
		});
	});

	it("builds sandbox stats from runtime inventory and execution counts", async () => {
		const sandboxInventory = fakeSandboxInventory();
		const sandboxRuntimeInventory = fakeSandboxRuntimeInventory();
		const service = makeServiceWithSandboxInventory(
			sandboxInventory,
			sandboxRuntimeInventory,
		);
		const now = new Date("2026-07-02T12:00:00.000Z");

		await expect(service.getSandboxStats({ now })).resolves.toEqual({
			total: 2,
			byPhase: {
				READY: 1,
				PROVISIONING: 1,
			},
			executions24h: 7,
			avgAgeMinutes: 45,
		});
		expect(sandboxRuntimeInventory.listSandboxes).toHaveBeenCalled();
		expect(sandboxInventory.countExecutionsSince).toHaveBeenCalledWith(
			new Date("2026-07-01T12:00:00.000Z"),
		);
	});

	it("composes workspace workflow summaries through application ports", async () => {
		const workflowDefinitions = {
			...makeService({}).workflowDefinitions,
			listForWorkspace: vi.fn(async () => [
				{
					id: "wf-idle",
					name: "Idle workflow",
					updatedAt: new Date("2026-01-02T00:00:00.000Z"),
				},
				{
					id: "wf-running",
					name: "Running workflow",
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			]),
		} satisfies WorkflowDefinitionRepository;
		const workflowExecutions = {
			countForksByWorkflowIds: vi.fn(async () => [
				{ workflowId: "wf-running", count: 2 },
			]),
			listRecentRunsByWorkflowIds: vi.fn(async () => [
				{
					workflowId: "wf-idle",
					id: "exec-idle",
					status: "success",
					startedAt: new Date("2026-01-02T01:00:00.000Z"),
					completedAt: new Date("2026-01-02T01:01:00.000Z"),
				},
				{
					workflowId: "wf-running",
					id: "exec-running",
					status: "running",
					startedAt: new Date("2026-01-01T01:00:00.000Z"),
					completedAt: null,
				},
			]),
		} as unknown as WorkflowExecutionRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.listWorkspaceWorkflowSummaries({
				limit: 100,
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual([
			expect.objectContaining({
				id: "wf-running",
				running: true,
				forkCount: 2,
				latestExecution: expect.objectContaining({ id: "exec-running" }),
			}),
			expect.objectContaining({
				id: "wf-idle",
				running: false,
				forkCount: 0,
				latestExecution: expect.objectContaining({ id: "exec-idle" }),
			}),
		]);
		expect(workflowDefinitions.listForWorkspace).toHaveBeenCalledWith({
			limit: 100,
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowExecutions.countForksByWorkflowIds).toHaveBeenCalledWith([
			"wf-idle",
			"wf-running",
		]);
    expect(workflowExecutions.listRecentRunsByWorkflowIds).toHaveBeenCalledWith(
      {
			workflowIds: ["wf-idle", "wf-running"],
			limitPerWorkflow: 3,
      },
    );
	});

	it("composes service-graph picker options through application ports", async () => {
		const workflowDefinitions = {
			...makeService({}).workflowDefinitions,
			listForWorkspace: vi.fn(async () => [
				{
					id: "wf-1",
					name: "Demo workflow",
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			]),
		} satisfies WorkflowDefinitionRepository;
		const workflowExecutions = {
			listRecentExecutionPickerRecords: vi.fn(async () => [
				{
					id: "exec-1",
					status: "success",
					startedAt: new Date("2026-01-02T03:04:00.000Z"),
					workflowId: "wf-1",
				},
			]),
		} as unknown as WorkflowExecutionRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.listServiceGraphPickerOptions({
				userId: "user-1",
				projectId: "project-1",
				workflowLimit: 200,
				executionLimit: 50,
			}),
		).resolves.toEqual({
			workflows: [{ id: "wf-1", name: "Demo workflow" }],
			executions: [
				{
					id: "exec-1",
					label: "Demo workflow \u00b7 success \u00b7 01-02 03:04",
					workflowId: "wf-1",
					workflowName: "Demo workflow",
					status: "success",
					startedAt: "2026-01-02T03:04:00.000Z",
				},
			],
			defaultExecutionId: "exec-1",
		});
		expect(workflowDefinitions.listForWorkspace).toHaveBeenCalledWith({
			limit: 200,
			userId: "user-1",
			projectId: "project-1",
		});
    expect(
      workflowExecutions.listRecentExecutionPickerRecords,
    ).toHaveBeenCalledWith({
			limit: 50,
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("resolves service-graph execution context through scoped workflow-data reads", async () => {
		const execution = workflowExecutionRecord();
		const { service, workflowDefinitions, workflowExecutions } = makeService({
			byId: {
				...baseWorkflow,
				id: "wf-id",
				nodes: [{ id: "node-1", data: { label: "Node 1" } }],
				edges: [{ source: "node-1", target: "node-2" }],
			},
			workflowExecutions: {
				getById: vi.fn(async () => execution),
			},
		});

		await expect(
			service.getObservabilityServiceGraphContext({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			execution,
			workflow: {
				id: "wf-id",
				nodes: [{ id: "node-1", data: { label: "Node 1" } }],
				edges: [{ source: "node-1", target: "node-2" }],
			},
			targetWorkflowId: "wf-id",
		});
		expect(workflowExecutions.getById).toHaveBeenCalledWith("exec-1");
		expect(workflowDefinitions.getById).toHaveBeenCalledWith("wf-id");
	});

	it("hides out-of-scope service-graph executions", async () => {
		const { service, workflowDefinitions, workflowExecutions } = makeService({
			byId: baseWorkflow,
			workflowExecutions: {
				getById: vi.fn(async () =>
					workflowExecutionRecord({ projectId: "project-2" }),
				),
			},
		});

		await expect(
			service.getObservabilityServiceGraphContext({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toBeNull();
		expect(workflowExecutions.getById).toHaveBeenCalledWith("exec-1");
		expect(workflowDefinitions.getById).not.toHaveBeenCalled();
	});

	it("resolves service-graph window workflow context through scoped workflow-data reads", async () => {
		const { service, workflowDefinitions } = makeService({
			byId: {
				...baseWorkflow,
				id: "wf-window",
				nodes: [{ id: "node-1" }],
				edges: [],
			},
		});

		await expect(
			service.getObservabilityServiceGraphContext({
				workflowId: "wf-window",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			execution: null,
			workflow: {
				id: "wf-window",
				nodes: [{ id: "node-1" }],
				edges: [],
			},
			targetWorkflowId: "wf-window",
		});
		expect(workflowDefinitions.getById).toHaveBeenCalledWith("wf-window");
	});

	it("lists service-graph step logs for a scoped execution", async () => {
		const execution = workflowExecutionRecord();
		const logs = [executionLogRecord()];
		const workflowExecutions = {
			getById: vi.fn(async () => execution),
			listLogsByExecutionId: vi.fn(async () => logs),
		};
		const { service } = makeService({ workflowExecutions });

		await expect(
			service.listObservabilityServiceGraphStepLogs({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toBe(logs);
		expect(workflowExecutions.getById).toHaveBeenCalledWith("exec-1");
    expect(workflowExecutions.listLogsByExecutionId).toHaveBeenCalledWith(
      "exec-1",
    );
	});

	it("hides service-graph step logs for out-of-scope executions", async () => {
		const workflowExecutions = {
      getById: vi.fn(async () =>
        workflowExecutionRecord({ projectId: "project-2" }),
      ),
			listLogsByExecutionId: vi.fn(async () => [executionLogRecord()]),
		};
		const { service } = makeService({ workflowExecutions });

		await expect(
			service.listObservabilityServiceGraphStepLogs({
				executionId: "exec-1",
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toBeNull();
		expect(workflowExecutions.listLogsByExecutionId).not.toHaveBeenCalled();
	});

	it("lists service-graph step logs for a scoped workflow window", async () => {
		const logs = [executionLogRecord()];
		const workflowExecutions = {
			listLogsByWorkflowSince: vi.fn(async () => logs),
		};
		const { service, workflowDefinitions } = makeService({
			byId: { ...baseWorkflow, id: "wf-window" },
			workflowExecutions,
		});

		await expect(
			service.listObservabilityServiceGraphStepLogs({
				workflowId: "wf-window",
				userId: "user-1",
				projectId: "project-1",
				windowSeconds: 900,
			}),
		).resolves.toBe(logs);
		expect(workflowDefinitions.getById).toHaveBeenCalledWith("wf-window");
		expect(workflowExecutions.listLogsByWorkflowSince).toHaveBeenCalledWith({
			workflowId: "wf-window",
			since: expect.any(Date),
			executionLimit: 2000,
		});
	});

	it("resolves workflow activity-rate target through the application port", async () => {
		const activityRateTargets: WorkflowActivityRateTargetRepository = {
			resolveWorkflowActivityRateTarget: vi.fn(async () => ({
				executionId: "exec-1",
				sessionId: "session-1",
				daprAppId: "agent-session-abc123",
			})),
		};
		const { service } = makeService({ activityRateTargets });

		await expect(
			service.resolveWorkflowActivityRateTarget({ executionId: "exec-1" }),
		).resolves.toEqual({
			executionId: "exec-1",
			sessionId: "session-1",
			daprAppId: "agent-session-abc123",
		});
		expect(
			activityRateTargets.resolveWorkflowActivityRateTarget,
		).toHaveBeenCalledWith({ executionId: "exec-1" });
	});

	it("resolves observability trace scope and goal chips through application ports", async () => {
		const observabilityTraces: ObservabilityTraceRepository = {
			getTraceScope: vi.fn(async () => ({
				sessionIds: ["session-1"],
				executionIds: ["exec-1"],
				sessionIdFilter: "session-1",
			})),
			hasAnyTraceOwnerInScope: vi.fn(async () => true),
			listTraceGoalChips: vi.fn(async () => [
				{
					sessionId: "session-1",
					status: "complete",
					iterations: 3,
					verdict: "pass" as const,
				},
			]),
		};
		const { service } = makeService({ observabilityTraces });

		await expect(
			service.getObservabilityTraceScope({
				userId: "user-1",
				projectId: "project-1",
				sessionIdFilter: "session-1",
				sessionLimit: 1000,
				executionLimit: 1000,
			}),
		).resolves.toEqual({
			sessionIds: ["session-1"],
			executionIds: ["exec-1"],
			sessionIdFilter: "session-1",
		});
		expect(observabilityTraces.getTraceScope).toHaveBeenCalledWith({
			userId: "user-1",
			projectId: "project-1",
			sessionIdFilter: "session-1",
			sessionLimit: 1000,
			executionLimit: 1000,
		});

		await expect(
			service.listObservabilityTraceGoalChips({
				sessionIds: ["session-1"],
			}),
		).resolves.toEqual([
			{
				sessionId: "session-1",
				status: "complete",
				iterations: 3,
				verdict: "pass",
			},
		]);
		expect(observabilityTraces.listTraceGoalChips).toHaveBeenCalledWith({
			sessionIds: ["session-1"],
		});
	});

	it("lists workflow monitor fallback executions through the read port", async () => {
		const startedAt = new Date("2026-01-01T00:00:00.000Z");
		const workflowMonitorReads: WorkflowMonitorReadRepository = {
			listFallbackExecutions: vi.fn(async () => [
				{
					id: "exec-1",
					instanceId: "dapr-exec-1",
					workflowId: "wf-1",
					workflowName: "Monitor workflow",
					status: "running" as const,
					phase: "executing",
					progress: 50,
					startedAt,
					completedAt: null,
					duration: null,
				},
			]),
		};
		const { service } = makeService({ workflowMonitorReads });

		await expect(
			service.listWorkflowMonitorFallbackExecutions({ limit: 50 }),
		).resolves.toEqual([
			{
				id: "exec-1",
				instanceId: "dapr-exec-1",
				workflowId: "wf-1",
				workflowName: "Monitor workflow",
				status: "running",
				phase: "executing",
				progress: 50,
				startedAt,
				completedAt: null,
				duration: null,
			},
		]);
		expect(workflowMonitorReads.listFallbackExecutions).toHaveBeenCalledWith({
			limit: 50,
		});
	});

	it("loads resource usage read models through the workflow-data port", async () => {
		const resourceUsages: ResourceUsageReadRepository = {
			getPromptPresetUsages: vi.fn(async () => ({
				latestVersion: 3,
				usages: [
					{
						id: "agent-1",
						slug: "agent-one",
						name: "Agent One",
						bindingKind: "static" as const,
						version: 2,
						latestVersion: 3,
						isStale: true,
					},
				],
			})),
			listAgentSkillUsedBy: vi.fn(async () => ({
				agents: [
					{
						id: "agent-1",
						slug: "agent-one",
						name: "Agent One",
						projectId: "project-1",
						runtimeAppId: "agent-session-abc",
						registryStatus: "synced",
					},
				],
				truncated: false,
				total: 1,
			})),
			getVaultUsages: vi.fn(async () => ({
				agents: [
					{
						id: "agent-1",
						slug: "agent-one",
						name: "Agent One",
						avatar: null,
						isArchived: false,
					},
				],
				sessionCount: 2,
			})),
		};
		const { service } = makeService({ resourceUsages });

		await expect(
			service.getPromptPresetUsages({
				presetId: "preset-1",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			latestVersion: 3,
			usages: [
				{
					id: "agent-1",
					slug: "agent-one",
					name: "Agent One",
					bindingKind: "static",
					version: 2,
					latestVersion: 3,
					isStale: true,
				},
			],
		});
		expect(resourceUsages.getPromptPresetUsages).toHaveBeenCalledWith({
			presetId: "preset-1",
			projectId: "project-1",
		});

		await expect(
			service.listAgentSkillUsedBy({
				skillRef: "skill-1",
				projectId: "project-1",
				limit: 50,
			}),
		).resolves.toEqual({
			agents: [
				{
					id: "agent-1",
					slug: "agent-one",
					name: "Agent One",
					projectId: "project-1",
					runtimeAppId: "agent-session-abc",
					registryStatus: "synced",
				},
			],
			truncated: false,
			total: 1,
		});
		expect(resourceUsages.listAgentSkillUsedBy).toHaveBeenCalledWith({
			skillRef: "skill-1",
			projectId: "project-1",
			limit: 50,
		});

		await expect(
			service.getVaultUsages({ vaultId: "vault-1" }),
		).resolves.toEqual({
			agents: [
				{
					id: "agent-1",
					slug: "agent-one",
					name: "Agent One",
					avatar: null,
					isArchived: false,
				},
			],
			sessionCount: 2,
		});
		expect(resourceUsages.getVaultUsages).toHaveBeenCalledWith({
			vaultId: "vault-1",
		});
	});

	it("lists and deletes AI assistant messages through the workflow-data port", async () => {
		const createdAt = new Date("2026-07-01T12:00:00.000Z");
		const aiAssistantMessages: WorkflowAiAssistantMessageRepository = {
			listMessages: vi.fn(async () => [
				{
					id: "message-1",
					role: "assistant" as const,
					content: "Done",
					operations: [{ op: "add_task" }],
					createdAt,
				},
			]),
			deleteMessages: vi.fn(async () => undefined),
		};
		const { service } = makeService({ aiAssistantMessages });

		await expect(
			service.listAiAssistantMessages({
				workflowId: "workflow-1",
				userId: "user-1",
				limit: 100,
			}),
		).resolves.toEqual([
			{
				id: "message-1",
				role: "assistant",
				content: "Done",
				operations: [{ op: "add_task" }],
				createdAt,
			},
		]);
		expect(aiAssistantMessages.listMessages).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			userId: "user-1",
			limit: 100,
		});

		await expect(
			service.deleteAiAssistantMessages({
				workflowId: "workflow-1",
				userId: "user-1",
			}),
		).resolves.toBeUndefined();
		expect(aiAssistantMessages.deleteMessages).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			userId: "user-1",
		});
	});

	it("loads security audit events through the workflow-data port", async () => {
		const now = new Date("2026-07-03T12:00:00.000Z");
		const securityAudit: SecurityAuditReadRepository = {
			getSecurityAudit: vi.fn(async () => ({
				events: [
					{
						id: "cred:access-1",
						at: "2026-07-03T11:00:00.000Z",
						kind: "credential.access" as const,
						summary: "github credential resolved via reference_forwarded",
						executionId: "exec-1",
					},
				],
				asOf: now.toISOString(),
			})),
		};
		const { service } = makeService({ securityAudit });

		await expect(
			service.getSecurityAudit({
				projectId: "project-1",
				now,
			}),
		).resolves.toEqual({
			events: [
				{
					id: "cred:access-1",
					at: "2026-07-03T11:00:00.000Z",
					kind: "credential.access",
					summary: "github credential resolved via reference_forwarded",
					executionId: "exec-1",
				},
			],
			asOf: now.toISOString(),
		});
		expect(securityAudit.getSecurityAudit).toHaveBeenCalledWith({
			projectId: "project-1",
			since: new Date("2026-06-03T12:00:00.000Z"),
			now,
			limit: 100,
		});
	});

	it("loads the dashboard read model through the workflow-data port", async () => {
		const now = new Date("2026-07-03T12:00:00.000Z");
		const dashboard: DashboardReadRepository = {
			getDashboard: vi.fn(async () => ({
				stats: {
					activeSessions: 1,
					sessionsToday: 2,
					archivedLast24h: 0,
					tokensOut7d: 100,
					tokensIn7d: 50,
					totalAgents: 3,
					totalEnvironments: 4,
					totalVaults: 5,
				},
				activeSessions: [
					{
						id: "session-1",
						title: "Active",
						status: "running",
						agentId: "agent-1",
						agentName: "Agent One",
						agentAvatar: null,
						updatedAt: now.toISOString(),
						createdAt: now.toISOString(),
					},
				],
				recentChanges: [
					{
						kind: "agent" as const,
						resourceId: "agent-1",
						resourceName: "Agent One",
						version: 2,
						publishedAt: now.toISOString(),
					},
				],
			})),
		};
		const { service } = makeService({ dashboard });

		await expect(
			service.getDashboard({
				userId: "user-1",
				now,
			}),
		).resolves.toEqual({
			stats: {
				activeSessions: 1,
				sessionsToday: 2,
				archivedLast24h: 0,
				tokensOut7d: 100,
				tokensIn7d: 50,
				totalAgents: 3,
				totalEnvironments: 4,
				totalVaults: 5,
			},
			activeSessions: [
				{
					id: "session-1",
					title: "Active",
					status: "running",
					agentId: "agent-1",
					agentName: "Agent One",
					agentAvatar: null,
					updatedAt: now.toISOString(),
					createdAt: now.toISOString(),
				},
			],
			recentChanges: [
				{
					kind: "agent",
					resourceId: "agent-1",
					resourceName: "Agent One",
					version: 2,
					publishedAt: now.toISOString(),
				},
			],
		});
		expect(dashboard.getDashboard).toHaveBeenCalledWith({
			userId: "user-1",
			now,
		});
	});

	it("checks contamination-risk audit access through user and project ports", async () => {
		const userProfiles: UserProfileRepository = {
			getUserProfile: vi.fn(async () => ({
				name: "Member",
				email: "member@example.test",
				image: null,
				platformRole: "MEMBER" as const,
			})),
		};
		const workspaceProjects: WorkspaceProjectRepository = {
			...fakeWorkspaceProjects(),
			getProjectMemberRole: vi.fn(async () => "OPERATOR" as const),
		};
		const { service } = makeService({ userProfiles, workspaceProjects });

		await expect(
			service.canViewContaminationRiskMetadata({
				userId: "user-1",
				projectId: "project-1",
			}),
		).resolves.toBe(true);
		expect(userProfiles.getUserProfile).toHaveBeenCalledWith("user-1");
		expect(workspaceProjects.getProjectMemberRole).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
	});

	it("lets platform admins audit contamination-risk metadata without project membership", async () => {
		const userProfiles: UserProfileRepository = {
			getUserProfile: vi.fn(async () => ({
				name: "Admin",
				email: "admin@example.test",
				image: null,
				platformRole: "ADMIN" as const,
			})),
		};
		const workspaceProjects: WorkspaceProjectRepository = {
			...fakeWorkspaceProjects(),
			getProjectMemberRole: vi.fn(async () => "VIEWER" as const),
		};
		const { service } = makeService({ userProfiles, workspaceProjects });

		await expect(
			service.canViewContaminationRiskMetadata({
				userId: "admin-1",
				projectId: "project-1",
			}),
		).resolves.toBe(true);
		expect(workspaceProjects.getProjectMemberRole).not.toHaveBeenCalled();
	});

	it("loads benchmark instance detail through the workflow-data port", async () => {
		const detail = {
			id: "inst-1",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: "Look at Add",
			testMetadata: { version: "1.7" },
			goldPatch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
			metadata: { issue_url: "https://example.test/issue" },
			suiteSlug: "SWE-bench_Lite",
			suiteName: "SWE-bench Lite",
		};
		const benchmarkInstanceDetails: BenchmarkInstanceDetailReadRepository = {
			getBenchmarkInstanceDetail: vi.fn(async () => detail),
		};
		const { service } = makeService({ benchmarkInstanceDetails });

		await expect(
			service.getBenchmarkInstanceDetail({
				suiteSlug: "SWE-bench_Lite",
				instanceId: "sympy__sympy-20590",
			}),
		).resolves.toEqual(detail);
    expect(
      benchmarkInstanceDetails.getBenchmarkInstanceDetail,
    ).toHaveBeenCalledWith({
			suiteSlug: "SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
		});
	});

	it("loads benchmark run-instance scores through the workflow-data port", async () => {
		const createdAt = new Date("2026-07-03T12:00:00.000Z");
    const benchmarkRunInstanceScores: BenchmarkRunInstanceScoreReadRepository =
      {
			listRunInstanceScores: vi.fn(async () => ({
				status: "ok" as const,
				scores: [
					{
						id: "score-1",
						scorerName: "reasoning_quality",
						scorerVersion: 1,
						score: 0.9,
						reasoning: "Clear reasoning",
						metadata: { model: "judge" },
						createdAt,
					},
				],
			})),
		};
		const { service } = makeService({ benchmarkRunInstanceScores });

		await expect(
			service.listBenchmarkRunInstanceScores({
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				projectId: "project-1",
			}),
		).resolves.toEqual({
			status: "ok",
			scores: [
				{
					id: "score-1",
					scorerName: "reasoning_quality",
					scorerVersion: 1,
					score: 0.9,
					reasoning: "Clear reasoning",
					metadata: { model: "judge" },
					createdAt,
				},
			],
		});
    expect(
      benchmarkRunInstanceScores.listRunInstanceScores,
    ).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
		});
	});

	it("loads benchmark run-instance detail through the workflow-data port", async () => {
		const evaluatedAt = new Date("2026-07-03T12:00:00.000Z");
    const benchmarkRunInstanceDetails: BenchmarkRunInstanceDetailReadRepository =
      {
			getRunInstanceDetail: vi.fn(async () => ({
				status: "ok" as const,
				mlflowExperimentId: "exp-1",
				runInstance: {
					id: "run-inst-1",
					runId: "run-1",
					instanceId: "sympy__sympy-20590",
					evaluationStatus: "resolved",
					evaluatedAt,
					harnessResult: { resolved: true },
					mlflowRunId: "mlflow-run-1",
					traceIds: ["trace-1"],
				},
				instance: {
					repo: "sympy/sympy",
					baseCommit: "abc123",
					problemStatement: "Fix it",
					hintsText: "Look at Add",
					testMetadata: { version: "1.7" },
					metadata: { issue_url: "https://example.test/issue" },
					goldPatch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
				},
				executionIr: { jobName: "bench-host-1" },
				executionOutput: null,
			})),
		};
		const { service } = makeService({ benchmarkRunInstanceDetails });

		await expect(
			service.getBenchmarkRunInstanceDetail({
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			status: "ok",
			mlflowExperimentId: "exp-1",
			runInstance: {
				id: "run-inst-1",
				instanceId: "sympy__sympy-20590",
			},
			instance: {
				repo: "sympy/sympy",
				baseCommit: "abc123",
			},
		});
    expect(
      benchmarkRunInstanceDetails.getRunInstanceDetail,
    ).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
		});
	});

	it("manages benchmark run-instance annotations through workflow-data ports", async () => {
		const updatedAt = new Date("2026-07-03T12:00:00.000Z");
    const benchmarkRunInstanceAnnotations: BenchmarkRunInstanceAnnotationRepository =
      {
			getRunInstanceAnnotations: vi.fn(async () => ({
				status: "ok" as const,
				mine: {
					verdict: "correct" as const,
					reasoning: "Looks right",
					updatedAt,
				},
				counts: {
					correct: 1,
					incorrect: 0,
					partial: 0,
					unsure: 0,
				},
			})),
        upsertRunInstanceAnnotation: vi.fn(async () => ({
          status: "ok" as const,
        })),
        deleteRunInstanceAnnotation: vi.fn(async () => ({
          status: "ok" as const,
        })),
		};
		const { service } = makeService({ benchmarkRunInstanceAnnotations });

		await expect(
			service.getBenchmarkRunInstanceAnnotations({
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toMatchObject({
			status: "ok",
			mine: { verdict: "correct", reasoning: "Looks right" },
		});

		await expect(
			service.upsertBenchmarkRunInstanceAnnotation({
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				projectId: "project-1",
				userId: "user-1",
				verdict: " partial ",
				reasoning: " Needs another look ",
			}),
		).resolves.toEqual({ status: "ok" });
    expect(
      benchmarkRunInstanceAnnotations.upsertRunInstanceAnnotation,
    ).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			projectId: "project-1",
			userId: "user-1",
			verdict: "partial",
			reasoning: "Needs another look",
		});

		await expect(
			service.upsertBenchmarkRunInstanceAnnotation({
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				projectId: "project-1",
				userId: "user-1",
				verdict: "maybe",
			}),
		).resolves.toEqual({
			status: "invalid_verdict",
			allowed: ["correct", "incorrect", "partial", "unsure"],
		});

		await expect(
			service.deleteBenchmarkRunInstanceAnnotation({
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				projectId: "project-1",
				userId: "user-1",
			}),
		).resolves.toEqual({ status: "ok" });
	});

	it("promotes benchmark run instances into evaluation datasets through workflow-data ports", async () => {
		const now = new Date("2026-07-03T13:00:00.000Z");
		const createdAt = new Date("2026-07-03T13:00:01.000Z");
		const updatedAt = new Date("2026-07-03T13:00:02.000Z");
		const benchmarkDatasetPromotions: BenchmarkDatasetPromotionRepository = {
			promoteRunInstanceToDataset: vi.fn(async () => ({
				status: "ok" as const,
				rows: [
					{
						id: "dataset-row-1",
						datasetId: "dataset-1",
						externalId: "sympy__sympy-20590",
						input: { instance_id: "sympy__sympy-20590" },
						expectedOutput: { harness_resolved: true },
						generatedOutput: null,
						annotations: {},
						rating: null,
						feedback: null,
						metadata: { promotedFromRunId: "run-1" },
						originRunInstanceId: "run-instance-1",
						originSessionId: "session-1",
						createdAt,
						updatedAt,
					},
				],
			})),
		};
		const { service } = makeService({ benchmarkDatasetPromotions });

		await expect(
			service.promoteBenchmarkRunInstanceToDataset({
				projectId: "project-1",
				datasetId: "dataset-1",
				runId: " run-1 ",
				instanceId: " sympy__sympy-20590 ",
				now,
			}),
		).resolves.toMatchObject({
			status: "ok",
			rows: [{ id: "dataset-row-1", originRunInstanceId: "run-instance-1" }],
		});
    expect(
      benchmarkDatasetPromotions.promoteRunInstanceToDataset,
    ).toHaveBeenCalledWith({
			projectId: "project-1",
			datasetId: "dataset-1",
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			now,
		});

		await expect(
			service.promoteBenchmarkRunInstanceToDataset({
				projectId: "project-1",
				datasetId: "dataset-1",
				runId: "run-1",
				instanceId: " ",
			}),
		).resolves.toEqual({
			status: "invalid_input",
			message: "runId and instanceId are required",
		});
	});

	it("loads benchmark run-instance progress through workflow-data ports", async () => {
		const now = new Date("2026-07-03T14:00:00.000Z");
		const latestActivityAt = new Date("2026-07-03T13:59:30.000Z");
    const benchmarkRunInstanceProgress: BenchmarkRunInstanceProgressReadRepository =
      {
			getRunInstanceProgress: vi.fn(async () => ({
				status: "ok" as const,
				runInstanceStatus: "running",
				inferenceStatus: "running",
				evaluationStatus: "pending",
				sessionId: "session-1",
				latestSessionEventType: "agent.llm_usage",
				latestSessionEventSequence: 42,
				latestActivityAt,
				activityAgeSeconds: 30,
				progressMarker: "running:running:pending:marker",
			})),
		};
		const { service } = makeService({ benchmarkRunInstanceProgress });

		await expect(
			service.getBenchmarkRunInstanceProgress({
				runId: "run-1",
				instanceId: "sympy__sympy-20590",
				now,
			}),
		).resolves.toMatchObject({
			status: "ok",
			sessionId: "session-1",
			activityAgeSeconds: 30,
		});
    expect(
      benchmarkRunInstanceProgress.getRunInstanceProgress,
    ).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			now,
		});
	});

	it("records benchmark artifact metadata through workflow-data ports", async () => {
		const benchmarkArtifactMetadata: BenchmarkArtifactMetadataRepository = {
			recordArtifact: vi.fn(async () => undefined),
		};
		const { service } = makeService({ benchmarkArtifactMetadata });

		await service.recordBenchmarkArtifact({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			kind: "predictions_jsonl",
			path: "predictions.jsonl",
			contentType: "application/jsonl; charset=utf-8",
			sizeBytes: 128,
			sha256: "abc123",
			metadata: {
				backend: "dapr-blob",
				objectKey: "swebench/dev/run-1/predictions.jsonl",
			},
		});

		expect(benchmarkArtifactMetadata.recordArtifact).toHaveBeenCalledWith({
			runId: "run-1",
			instanceId: "sympy__sympy-20590",
			kind: "predictions_jsonl",
			path: "predictions.jsonl",
			contentType: "application/jsonl; charset=utf-8",
			sizeBytes: 128,
			sha256: "abc123",
			metadata: {
				backend: "dapr-blob",
				objectKey: "swebench/dev/run-1/predictions.jsonl",
			},
		});
	});

	it("ingests benchmark evaluation callbacks through workflow-data ports", async () => {
		const benchmarkEvaluationResults: BenchmarkEvaluationResultRepository = {
			getRunForEvaluationIngestion: vi.fn(async () => ({
				id: "run-1",
				status: "evaluating" as const,
			})),
			loadPatchContexts: vi.fn(async () => new Map()),
			batchUpdateEvaluationResults: vi.fn(async () => undefined),
			countActiveEvaluationRows: vi.fn(async () => 1),
			getRunForResponse: vi.fn(async () => ({
				id: "run-1",
				status: "evaluating" as const,
			})),
		};
		const benchmarkRunLifecycle: BenchmarkRunLifecyclePort = {
			markStatus: vi.fn(async (_runId, status) => ({ id: "run-1", status })),
			recomputeSummary: vi.fn(async () => ({ resolved: 1 })),
		};
		const benchmarkEvaluationTelemetry: BenchmarkEvaluationTelemetryPort = {
			syncEvaluationResults: vi.fn(),
		};
		const benchmarkEvaluationEvents: BenchmarkEvaluationEventNotifier = {
			notifyEvaluationEvent: vi.fn(async () => undefined),
		};
		const { service } = makeService({
			benchmarkEvaluationResults,
			benchmarkRunLifecycle,
			benchmarkEvaluationTelemetry,
			benchmarkEvaluationEvents,
		});

		await expect(
			service.ingestBenchmarkEvaluationResults({
				runId: "run-1",
				results: [{ instance_id: "inst-1", resolved: true }],
				error: null,
				jobName: "job-1",
			}),
		).resolves.toMatchObject({
			status: "ok",
			summary: { resolved: 1 },
		});
    expect(
      benchmarkEvaluationResults.batchUpdateEvaluationResults,
    ).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				updates: [
					expect.objectContaining({
						instanceId: "inst-1",
						status: "resolved",
						evaluationStatus: "resolved",
					}),
				],
			}),
		);
    expect(
      benchmarkEvaluationTelemetry.syncEvaluationResults,
    ).toHaveBeenCalledWith({
			runId: "run-1",
			instanceIds: ["inst-1"],
		});
    expect(
      benchmarkEvaluationEvents.notifyEvaluationEvent,
    ).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				eventType: "results",
				jobName: "job-1",
			}),
		);
	});

	it("loads benchmark run project ids through workflow-data ports", async () => {
		const benchmarkRuns: BenchmarkRunRepository = {
			getProjectId: vi.fn(async () => "project-1"),
			getSessionProvisioningGate: vi.fn(async () => null),
		};
		const { service } = makeService({ benchmarkRuns });

    await expect(service.getBenchmarkRunProjectId("run-1")).resolves.toBe(
      "project-1",
    );
		expect(benchmarkRuns.getProjectId).toHaveBeenCalledWith("run-1");
	});

	it("loads piece catalog detail and connection usage through application ports", async () => {
		const pieceCatalog = {
			getLatestPieceMetadata: vi.fn(async () => ({
				name: "github",
				displayName: "GitHub",
				description: "GitHub actions",
				logoUrl: "https://example.test/github.svg",
				categories: ["dev"],
				version: "1.0.0",
				auth: { type: "OAUTH2" },
				actions: { create_issue: {} },
				availableOnly: false,
				catalogSourceImage: "piece-mcp-server:test",
				catalogSyncedAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-02T00:00:00.000Z"),
			})),
			listConnectablePieces: vi.fn(async () => []),
			listPieceCatalogFunctions: vi.fn(async () => []),
			listMcpCatalogPieces: vi.fn(async () => []),
			listConnectionUsageByPieceNames: vi.fn(async () => [
				{ connectionExternalId: "conn-1", refCount: 3, workflowCount: 2 },
			]),
		} satisfies PieceCatalogRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog,
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.getPieceCatalogDetail({
				pieceNameCandidates: ["github", "@activepieces/piece-github"],
				projectId: "project-1",
			}),
		).resolves.toMatchObject({
			piece: { name: "github", displayName: "GitHub" },
			usageByConnection: {
				"conn-1": { refCount: 3, workflowCount: 2 },
			},
		});
		expect(pieceCatalog.getLatestPieceMetadata).toHaveBeenCalledWith([
			"github",
			"@activepieces/piece-github",
		]);
		expect(pieceCatalog.listConnectionUsageByPieceNames).toHaveBeenCalledWith({
			pieceNameCandidates: ["github", "@activepieces/piece-github"],
			projectId: "project-1",
		});
	});

	it("composes the dev preview hub read model through workflow-data ports", async () => {
		const devEnvironments = fakeDevEnvironments();
		const { service, workflowDefinitions } = makeService({ devEnvironments });
		vi.mocked(workflowDefinitions.findProjectWorkflowIdByIdOrNamePrefix)
			.mockResolvedValueOnce("workflow-preview-ui-gan")
			.mockResolvedValueOnce("workflow-preview-lifecycle");

		await expect(
			service.getDevPreviewHubReadModel({ projectId: "project-1" }),
		).resolves.toEqual({
			services: expect.arrayContaining([
				expect.objectContaining({ service: "workflow-builder" }),
			]),
			devWorkflowId: "workflow-preview-ui-gan",
			devWorkflowName: "preview-ui-development-gan",
			lifecycleWorkflowId: "workflow-preview-lifecycle",
			lifecycleWorkflowName: "preview-development-lifecycle",
		});
		expect(devEnvironments.listServices).toHaveBeenCalledOnce();
    expect(
      workflowDefinitions.findProjectWorkflowIdByIdOrNamePrefix,
    ).toHaveBeenNthCalledWith(1, {
				projectId: "project-1",
				workflowId: "preview-ui-development-gan",
				namePrefix: "Preview UI development GAN%",
    });
    expect(
      workflowDefinitions.findProjectWorkflowIdByIdOrNamePrefix,
    ).toHaveBeenNthCalledWith(2, {
				projectId: "project-1",
				workflowId: "preview-development-lifecycle",
				namePrefix: "Preview development lifecycle%",
    });
	});

	it("loads dev environment list and detail through dev environment ports", async () => {
		const devEnvironments = fakeDevEnvironments();
		const { service } = makeService({ devEnvironments });

		await expect(
			service.listDevEnvironments({ projectId: "project-1" }),
		).resolves.toEqual([
			expect.objectContaining({
				executionId: "exec-1",
				service: "workflow-builder",
			}),
		]);
		expect(devEnvironments.listDevEnvironments).toHaveBeenCalledWith(
			"project-1",
		);

		await expect(
			service.getDevEnvironmentOrPending({
				executionId: "exec-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				executionId: "exec-1",
				sandboxName: "sandbox-1",
			}),
		);
		expect(devEnvironments.getDevEnvironmentOrPending).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
		});

		await expect(
			service.getDevEnvironmentTeardownTarget({
				executionId: "exec-1",
				projectId: "project-1",
			}),
		).resolves.toEqual(
			expect.objectContaining({
				executionId: "exec-1",
				runStatus: "cancelled",
			}),
		);
    expect(
      devEnvironments.getDevEnvironmentTeardownTarget,
    ).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
		});

		await expect(
			service.resolveCanonicalExecutionId({
				executionId: "sw-wf-1-exec-exec-1",
			}),
		).resolves.toBe("exec-1");
		expect(devEnvironments.resolveCanonicalExecutionId).toHaveBeenCalledWith({
			executionId: "sw-wf-1-exec-exec-1",
		});

		await expect(service.listDevPreviewServices()).resolves.toEqual([
			expect.objectContaining({ service: "workflow-builder" }),
		]);
		expect(devEnvironments.listServices).toHaveBeenCalledOnce();
	});

	it("composes benchmark runs page filters through benchmark read ports", async () => {
		const benchmarkRunReads = fakeBenchmarkRunReads();
		const { service } = makeService({ benchmarkRunReads });

		await expect(
			service.getBenchmarkRunsPageReadModel({ projectId: "project-1" }),
		).resolves.toMatchObject({
			runs: [
				expect.objectContaining({ id: "run-1" }),
				expect.objectContaining({ id: "run-2" }),
			],
			suiteOptions: [{ slug: "SWE-bench_Verified", count: 2 }],
			agentOptions: [
				expect.objectContaining({ name: "Agent One", count: 1 }),
				expect.objectContaining({ name: "Agent Two", count: 1 }),
			],
			modelOptions: [
				{ model: "model-a", count: 1 },
				{ model: "model-b", count: 1 },
			],
			tagOptions: [
				{ tag: "campaign-a", count: 2 },
				{ tag: "campaign-b", count: 1 },
			],
		});
		expect(benchmarkRunReads.listRuns).toHaveBeenCalledWith({
			projectId: "project-1",
			limit: 100,
		});
	});

	it("resolves benchmark compare requests and tag shortcuts through benchmark read ports", async () => {
		const benchmarkRunReads = fakeBenchmarkRunReads();
		const { service } = makeService({ benchmarkRunReads });

		await expect(
			service.getBenchmarkComparePageReadModel({
				projectId: "project-1",
				runsParam: "run-1, run-2",
			}),
		).resolves.toMatchObject({
			runIds: ["run-1", "run-2"],
			resolvedFromTag: null,
			compare: {
				runs: [
					expect.objectContaining({ runId: "run-1" }),
					expect.objectContaining({ runId: "run-2" }),
				],
			},
		});
		expect(benchmarkRunReads.loadCompareData).toHaveBeenCalledWith({
			projectId: "project-1",
			runIds: ["run-1", "run-2"],
		});

		await expect(
			service.getBenchmarkComparePageReadModel({
				projectId: "project-1",
				tag: "campaign-a",
			}),
		).resolves.toMatchObject({
			runIds: ["run-1", "run-2"],
			resolvedFromTag: "campaign-a",
			compare: expect.objectContaining({
				allInstanceIds: ["inst-1"],
			}),
		});
		expect(benchmarkRunReads.listRuns).toHaveBeenCalledWith({
			projectId: "project-1",
			limit: 100,
			tag: "campaign-a",
		});
	});

	it("does not load compare data for fewer than two benchmark runs", async () => {
		const benchmarkRunReads = fakeBenchmarkRunReads();
		const { service } = makeService({ benchmarkRunReads });

		await expect(
			service.getBenchmarkComparePageReadModel({
				projectId: "project-1",
				runsParam: "run-1",
			}),
		).resolves.toEqual({
			compare: null,
			runIds: ["run-1"],
			resolvedFromTag: null,
		});
		expect(benchmarkRunReads.loadCompareData).not.toHaveBeenCalled();
	});

	it("composes the benchmark browser read model through benchmark ports", async () => {
		const benchmarkBrowser = {
			ensureDefaultSuites: vi.fn(async () => undefined),
			listInstances: vi.fn(async () => [
				{
					id: "instance-row-1",
					instanceId: "django__django-1",
					repo: "django/django",
					baseCommit: "1234567890abcdef",
					problemStatement: " Fix   a   failing   regression. ",
					hintsText: "try the failing test",
					testMetadata: { version: "5.0" },
					suiteSlug: "swebench-lite",
					suiteName: "SWE-bench Lite",
					datasetName: "princeton-nlp/SWE-bench_Lite",
				},
			]),
			listRepoFacets: vi.fn(async () => [{ repo: "django/django", count: 1 }]),
			listSuites: vi.fn(async () => [
				{ id: "suite-1", slug: "swebench-lite", name: "SWE-bench Lite" },
			]),
			listEnvironmentBuilds: vi.fn(async () => []),
			listRunnableAgentCandidates: vi.fn(async () => []),
		} satisfies BenchmarkBrowserRepository;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser,
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.getBenchmarkBrowserReadModel({ projectId: "project-1" }),
		).resolves.toMatchObject({
			instances: [
				{
					id: "instance-row-1",
					instanceId: "django__django-1",
					suiteSlug: "swebench-lite",
					repo: "django/django",
					baseCommit: "1234567890ab",
					version: "5.0",
					environmentStatus: "not_built",
					problemPreview: "Fix a failing regression.",
					hasHints: true,
					hintsLen: 20,
				},
			],
      repoFacets: [
        { value: "django/django", label: "django/django", count: 1 },
      ],
			suiteFacets: [
				{
					slug: "swebench-lite",
					name: "SWE-bench Lite",
					instanceCount: 1,
					environmentCoverage: {
						validated: 0,
						building: 0,
						failed: 0,
						notBuilt: 1,
					},
				},
			],
			runnableAgents: [],
		});
		expect(benchmarkBrowser.ensureDefaultSuites).toHaveBeenCalled();
		expect(benchmarkBrowser.listRunnableAgentCandidates).toHaveBeenCalledWith({
			projectId: "project-1",
		});
	});

	it("validates webhook API keys through the API-key port", async () => {
		const apiKeys = {
			...fakeApiKeys(),
      getByKeyHash: vi.fn(
        async () =>
          ({
            id: "key-1",
            userId: "user-1",
            projectId: null,
            createdByUserId: "user-1",
            scopes: [],
          }) as ApiKeyRecord,
      ),
			markUsed: vi.fn(async () => undefined),
		} satisfies ApiKeyStore;
    const workspaceProjects = fakeWorkspaceProjects();
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys,
      workspaceProjects,
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.validateApiKeyForUser({
				authorizationHeader: "Bearer wfb_test_secret",
				userId: "user-1",
			}),
		).resolves.toEqual({ valid: true, apiKeyId: "key-1" });
		expect(apiKeys.getByKeyHash).toHaveBeenCalledWith(expect.any(String));
		expect(apiKeys.markUsed).toHaveBeenCalledWith("key-1", expect.any(Date));

		await expect(
			service.validateApiKeyForUser({
				authorizationHeader: "Bearer wfb_test_secret",
				userId: "other-user",
			}),
		).resolves.toMatchObject({ valid: false, statusCode: 403 });

    apiKeys.getByKeyHash.mockResolvedValue({
      id: "key-2",
      userId: "user-1",
      projectId: "project-1",
      createdByUserId: "user-1",
      scopes: ["workflow:read", "workflow:write", "workflow:execute"],
    });
    await expect(
      service.validateApiKeyForUser({
        authorizationHeader: "Bearer wfb_test_secret",
        userId: "different-workflow-owner",
        projectId: "project-1",
      }),
    ).resolves.toEqual({ valid: true, apiKeyId: "key-2" });
    expect(workspaceProjects.hasActiveProjectMembership).toHaveBeenCalledWith({
      projectId: "project-1",
      userId: "user-1",
    });

    await expect(
      service.validateApiKeyForUser({
        authorizationHeader: "Bearer wfb_test_secret",
        userId: "user-1",
        projectId: "project-2",
      }),
    ).resolves.toMatchObject({ valid: false, statusCode: 403 });

    apiKeys.getByKeyHash.mockResolvedValue({
      id: "key-3",
      userId: "user-1",
      projectId: "project-1",
      createdByUserId: "user-1",
      scopes: ["workflow:read"],
    });
    await expect(
      service.validateApiKeyForUser({
        authorizationHeader: "Bearer wfb_test_secret",
        userId: "user-1",
        projectId: "project-1",
      }),
    ).resolves.toMatchObject({ valid: false, statusCode: 403 });

    vi.mocked(
      workspaceProjects.hasActiveProjectMembership,
    ).mockResolvedValueOnce(false);
    await expect(
      service.resolveApiKey({ authorizationHeader: "Bearer wfb_test_secret" }),
    ).resolves.toMatchObject({
      valid: false,
      statusCode: 403,
      error: expect.stringContaining("active member"),
    });

    vi.mocked(
      workspaceProjects.hasActiveProjectMembership,
    ).mockResolvedValueOnce(true);
    apiKeys.getByKeyHash.mockResolvedValue({
      id: "key-4",
      userId: "user-1",
      projectId: "project-1",
      createdByUserId: "user-1",
      scopes: ["workflow:read", "workflow:write"],
    });
    await expect(
      service.resolveApiKey({ authorizationHeader: "bearer wfb_test_secret" }),
    ).resolves.toEqual({
      valid: true,
      apiKeyId: "key-4",
      userId: "user-1",
      projectId: "project-1",
      scopes: ["workflow:read", "workflow:write"],
    });

    vi.mocked(workspaceProjects.getProjectMemberRole).mockResolvedValueOnce(
      "VIEWER",
    );
    await expect(
      service.resolveApiKey({ authorizationHeader: "Bearer wfb_test_secret" }),
    ).resolves.toMatchObject({
      valid: false,
      statusCode: 403,
      error: expect.stringContaining("authoring role"),
    });
	});

	it("manages user API keys through the API-key port", async () => {
		const apiKeys = {
			...fakeApiKeys(),
      listVisibleInProject: vi.fn(async () => [
				{
					id: "key-1",
					name: "Webhook",
					keyPrefix: "wfb_abc...",
          projectId: "project-1",
          createdByUserId: "user-1",
          scopes: [
            "workflow:read",
            "workflow:write",
            "workflow:execute",
            "agent:write",
          ],
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					lastUsedAt: null,
				},
			]),
      createProjectApiKey: vi.fn(async (input) => ({
				id: input.id,
				name: input.name,
				keyPrefix: input.keyPrefix,
        projectId: input.projectId,
        createdByUserId: input.createdByUserId,
        scopes: input.scopes,
				createdAt: new Date("2026-01-02T00:00:00.000Z"),
				lastUsedAt: null,
			})),
      deleteForProject: vi.fn(async () => true),
      updateSecretForProject: vi.fn(async (input) => ({
				id: input.id,
				name: "Webhook",
				keyPrefix: input.keyPrefix,
        projectId: input.projectId,
        createdByUserId: input.userId,
        scopes: [
          "workflow:read",
          "workflow:write",
          "workflow:execute",
          "agent:write",
        ],
				createdAt: new Date("2026-01-02T00:00:00.000Z"),
				lastUsedAt: null,
			})),
		} satisfies ApiKeyStore;
    const workspaceProjects = fakeWorkspaceProjects();
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys,
      workspaceProjects,
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
      service.listUserApiKeys({ userId: "user-1", projectId: "project-1" }),
    ).resolves.toHaveLength(1);
    await expect(
      service.createUserApiKey({
        userId: "user-1",
        projectId: "project-1",
        name: " Workflow MCP ",
      }),
		).resolves.toMatchObject({
      name: "Workflow MCP",
      projectId: "project-1",
      scopes: [
        "workflow:read",
        "workflow:write",
        "workflow:execute",
        "agent:write",
      ],
			keyPrefix: expect.stringMatching(/^wfb_/),
			key: expect.stringMatching(/^wfb_/),
		});
		await expect(
      service.rotateUserApiKey({
        userId: "user-1",
        projectId: "project-1",
        keyId: "key-1",
      }),
		).resolves.toMatchObject({
			id: "key-1",
			keyPrefix: expect.stringMatching(/^wfb_/),
			key: expect.stringMatching(/^wfb_/),
		});
		await expect(
      service.deleteUserApiKey({
        userId: "user-1",
        projectId: "project-1",
        keyId: "key-1",
      }),
		).resolves.toBe(true);

    expect(apiKeys.listVisibleInProject).toHaveBeenCalledWith({
      userId: "user-1",
      projectId: "project-1",
    });
    expect(apiKeys.createProjectApiKey).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
        projectId: "project-1",
        createdByUserId: "user-1",
        name: "Workflow MCP",
        scopes: [
          "workflow:read",
          "workflow:write",
          "workflow:execute",
          "agent:write",
        ],
				keyHash: expect.any(String),
				keyPrefix: expect.stringMatching(/^wfb_/),
			}),
		);
    expect(apiKeys.updateSecretForProject).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "key-1",
				userId: "user-1",
        projectId: "project-1",
				keyHash: expect.any(String),
				keyPrefix: expect.stringMatching(/^wfb_/),
			}),
		);
    expect(apiKeys.deleteForProject).toHaveBeenCalledWith({
			id: "key-1",
			userId: "user-1",
      projectId: "project-1",
		});

    vi.mocked(workspaceProjects.getProjectMemberRole).mockResolvedValue(
      "VIEWER",
    );
    await expect(
      service.createUserApiKey({
        userId: "user-1",
        projectId: "project-1",
        name: "Denied",
      }),
    ).resolves.toBeNull();
    await expect(
      service.rotateUserApiKey({
        userId: "user-1",
        projectId: "project-1",
        keyId: "key-1",
      }),
    ).resolves.toBeNull();
	});

	it("delegates agent-run lifecycle operations to the agent-run port", async () => {
		const agentRuns = {
			upsertScheduledAgentRun: vi.fn(async () => ({ id: "agent-run-1" })),
			updateAgentRunLifecycle: vi.fn(async () => ({
				id: "agent-run-1",
				status: "completed" as const,
			})),
			listByWorkflowExecutionId: vi.fn(async () => []),
		} satisfies WorkflowAgentRunStore;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

		await expect(
			service.upsertScheduledAgentRun({
				id: "agent-run-1",
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "agent",
				mode: "run",
				agentWorkflowId: "agent-run-1",
				daprInstanceId: "agent-run-1",
				parentExecutionId: "parent-1",
			}),
		).resolves.toEqual({ id: "agent-run-1" });
		await service.updateAgentRunLifecycle({
			id: "agent-run-1",
			status: "completed",
			result: { ok: true },
		});

		expect(agentRuns.upsertScheduledAgentRun).toHaveBeenCalledTimes(1);
		expect(agentRuns.updateAgentRunLifecycle).toHaveBeenCalledWith({
			id: "agent-run-1",
			status: "completed",
			result: { ok: true },
		});
		await expect(
			service.listWorkflowAgentRunsByExecutionId("exec-1"),
		).resolves.toEqual([]);
		expect(agentRuns.listByWorkflowExecutionId).toHaveBeenCalledWith("exec-1");
	});

	it("delegates plan artifacts and OTel trace lineage to their ports", async () => {
		const planArtifacts = {
			upsertPlanArtifact: vi.fn(async () => ({
				artifactRef: "plan-1",
				storageBackend: "workflow_plan_artifacts" as const,
				artifactType: "claude_task_graph_v1",
				status: "draft" as const,
			})),
			updatePlanArtifactStatus: vi.fn(async () => ({
				artifactRef: "plan-1",
				status: "approved" as const,
			})),
			listPlanArtifactsByExecutionId: vi.fn(async () => []),
			getPlanArtifact: vi.fn(async () => null),
		} satisfies WorkflowPlanArtifactStore;
		const traceLineage = {
			getTraceTargetsForExecution: vi.fn(async () => []),
			upsertTraceLineageLinks: vi.fn(async () => ({
				recorded: 1,
				sourceKeys: ["source-key"],
			})),
		} satisfies TraceLineageStore;
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions: {} as WorkflowExecutionRepository,
			sessionEventNotifications: fakeSessionEventNotifications(),
			artifactStore: {} as ArtifactStore,
			workspaceSessions: {} as WorkspaceSessionStore,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts,
			traceLineage,
		});

		await service.upsertPlanArtifact({
			artifactRef: "plan-1",
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "agent",
			goal: "ship it",
			planJson: { steps: [] },
		});
		await service.updatePlanArtifactStatus({
			artifactRef: "plan-1",
			status: "approved",
		});
		await service.listPlanArtifactsByExecutionId("exec-1");
		await service.upsertTraceLineageLinks({
			traceId: "tr-1234567890abcdef1234567890abcdef",
			targets: [
				{
					entityType: "workflow_execution",
					entityId: "exec-1",
					projectId: "project-1",
					externalExperimentId: "exp-1",
					externalRunId: "run-1",
				},
			],
		});

		expect(planArtifacts.upsertPlanArtifact).toHaveBeenCalledTimes(1);
		expect(planArtifacts.updatePlanArtifactStatus).toHaveBeenCalledTimes(1);
    expect(planArtifacts.listPlanArtifactsByExecutionId).toHaveBeenCalledWith(
      "exec-1",
    );
		expect(traceLineage.upsertTraceLineageLinks).toHaveBeenCalledTimes(1);
	});

	it("delegates execution, artifact, and workspace persistence to their ports", async () => {
		const executionLog = {
			id: "log-1",
			executionId: "exec-1",
			nodeId: "agent",
			nodeName: "Agent",
			nodeType: "action",
			activityName: "durable/run",
			status: "running" as const,
			input: {},
			output: null,
			error: null,
			startedAt: new Date("2026-01-01T00:00:00.000Z"),
			completedAt: null,
			duration: null,
			timestamp: new Date("2026-01-01T00:00:00.000Z"),
			credentialFetchMs: null,
			routingMs: null,
			coldStartMs: null,
			executionMs: null,
			routedTo: null,
			wasColdStart: null,
		};
		const workflowExecutions = {
			assertReadModelReady: vi.fn(async () => undefined),
			getById: vi.fn(async () => null),
			getByDaprInstanceId: vi.fn(async () => null),
			getExecutionWorkspaceKey: vi.fn(async (executionId) => executionId),
			getSessionOwnerContext: vi.fn(async () => ({
				userId: "user-1",
				workflowId: "wf-1",
				projectId: "project-1",
			})),
			getRunningByWorkflowId: vi.fn(async () => null),
			getLineage: vi.fn(async () => ({
				rootId: "exec-1",
				currentId: "exec-1",
				nodes: [],
			})),
			listActiveForUser: vi.fn(async () => []),
			listForInternalAgent: vi.fn(async () => ({
				success: true as const,
				executions: [],
				total: 0,
			})),
			getExecutionWorkspaceRoute: vi.fn(async () => ({
				projectId: "project-1",
				userId: "user-1",
				workspaceSlug: "workspace-1",
			})),
			listByWorkflowId: vi.fn(async () => []),
			listRunSummariesByWorkflowId: vi.fn(async () => []),
			listProjectRuns: vi.fn(async () => []),
			countForksByWorkflowIds: vi.fn(async () => []),
			listRecentRunsByWorkflowIds: vi.fn(async () => []),
			listRecentExecutionPickerRecords: vi.fn(async () => []),
			listSessionsForExecutionLineage: vi.fn(async () => []),
			listOutputFilesByExecutionId: vi.fn(async () => ({
				files: [],
				liveSandbox: null,
				cliWorkspace: false,
			})),
			aggregateUsageMetricsForExecutionLineage: vi.fn(async () => []),
			create: vi.fn(async () => ({ id: "exec-1" })),
			attachSchedulerInstance: vi.fn(async () => undefined),
			markStartFailed: vi.fn(async () => undefined),
				listStaleRunningExecutions: vi.fn(async () => []),
				applyRuntimeProjection: vi.fn(async () => ({ applied: true as const })),
				compareAndSetReadModel: vi.fn(async () => null),
			appendLog: vi.fn(async () => executionLog),
      updateLog: vi.fn(async () => ({
        ...executionLog,
        status: "success" as const,
      })),
				listLogsByExecutionId: vi.fn(async () => [executionLog]),
				listLogsByWorkflowSince: vi.fn(async () => [executionLog]),
				listSessionIdsByExecutionId: vi.fn(async () => ["session-1"]),
			countActiveTriggeredRuns: vi.fn(async () => 0),
			listAgentEventsByExecutionId: vi.fn(async () => []),
			listRecentAgentEventsByExecutionId: vi.fn(async () => []),
			listAgentEventsByExecutionIdAfter: vi.fn(async () => []),
		} satisfies WorkflowExecutionRepository;
		const sessions = fakeSessions();
		const sessionEvents = fakeSessionEvents();
		const artifactStore = {
			upsertWorkflowArtifact: vi.fn(async () => ({ id: "artifact-1" })),
			listWorkflowArtifactsByExecutionId: vi.fn(async () => []),
			listSourceBundleArtifactsByWorkflowId: vi.fn(async () => []),
			getWorkflowArtifactForExecution: vi.fn(async () => null),
			updateWorkflowArtifactMetadata: vi.fn(async () => null),
			mergeWorkflowArtifactMetadata: vi.fn(async () => null),
		} satisfies ArtifactStore;
		const workflowFiles = fakeWorkflowFiles();
		const workspaceSessions = {
			upsertWorkflowWorkspaceSession: vi.fn(async () => ({
				workspaceRef: "workspace-1",
			})),
			listWorkflowWorkspaceSessionsByExecutionId: vi.fn(async () => []),
			markWorkflowWorkspaceSessionCleaned: vi.fn(async () => true),
		} satisfies WorkspaceSessionStore;
		const modelCatalog = {
			listEnabledModelIds: vi.fn(async () => ["openai/gpt-5.5"]),
		};
		const sessionEventNotifications = fakeSessionEventNotifications();
		const service = new ApplicationWorkflowDataService({
			workflowDefinitions: makeService({}).workflowDefinitions,
			workflowTriggers: fakeWorkflowTriggers(),
			userProfiles: fakeUserProfiles(),
			settings: fakeSettings(),
		mcpConnections: fakeMcpConnections(),
		hostedMcpServers: fakeHostedMcpServers(),
		mcpRuns: fakeMcpRuns(),
		appConnections: fakeAppConnections(),
			adminPieces: fakeAdminPieces(),
			apiKeys: fakeApiKeys(),
			workspaceProjects: fakeWorkspaceProjects(),
			pieceCatalog: fakePieceCatalog(),
			benchmarkBrowser: fakeBenchmarkBrowser(),
			workflowExecutions,
			modelCatalog,
			sessions,
			sessionEvents,
			sessionEventNotifications,
			artifactStore,
			workflowFiles,
			workspaceSessions,
			agentRuns: {} as WorkflowAgentRunStore,
			planArtifacts: {} as WorkflowPlanArtifactStore,
			traceLineage: {} as TraceLineageStore,
		});

			await service.applyExecutionRuntimeProjection("exec-1", { phase: "running" });
			await service.compareAndSetExecutionReadModel({
				executionId: "exec-1",
				expectedStatus: "running",
				patch: { status: "success" },
			});
		await service.assertExecutionReadModelReady();
		await service.listEnabledModelIds();
		await service.createWorkflowExecution({
			id: "exec-1",
			workflowId: "wf-1",
			userId: "user-1",
			status: "running",
			workflowSessionId: "exec-1",
		});
		await service.attachExecutionSchedulerInstance({
			executionId: "exec-1",
			instanceId: "sw-example-exec-exec-1",
			primaryTraceId: "trace-1",
		});
		await service.markExecutionStartFailed({
			executionId: "exec-1",
			error: "failed to start",
		});
		await service.getExecutionByDaprInstanceId("sw-example-exec-exec-1");
		await service.getWorkflowExecutionWorkspaceKey("exec-1");
		await service.getWorkflowExecutionSessionOwnerContext("exec-1");
		await service.getRunningWorkflowExecution("wf-1");
		await service.getExecutionLineage("exec-1");
		await service.listActiveWorkflowExecutionsForUser("user-1");
		await service.listInternalAgentWorkflowExecutions({
			workflowId: "wf-1",
			workflowName: "Example",
			status: "running",
			limit: 25,
			offset: 5,
		});
		await service.listWorkflowExecutions({
			workflowId: "wf-1",
			limit: 20,
			include: "summary",
		});
		await service.listWorkflowExecutionRunSummaries({
			workflowId: "wf-1",
			limit: 20,
		});
		await service.listProjectWorkflowRuns({
			projectId: "project-1",
			workflowId: "wf-1",
			status: "running",
			since: new Date("2026-01-01T00:00:00.000Z"),
			q: "Example",
			limit: 10,
		});
		await service.listExecutionSessions({
			executionId: "exec-1",
			projectId: "project-1",
		});
		await service.listExecutionOutputFiles("exec-1");
		await service.aggregateExecutionUsageMetrics({
			executionId: "exec-1",
			projectId: "project-1",
		});
		await service.listStaleRunningExecutions({ olderThanMinutes: 60 });
		await service.appendExecutionLog({
			executionId: "exec-1",
			nodeId: "agent",
			nodeName: "Agent",
			nodeType: "action",
			status: "running",
		});
		await service.updateExecutionLog("exec-1", "log-1", { status: "success" });
		await service.listExecutionLogs("exec-1");
		await service.listExecutionSessionIds("exec-1");
		await service.listExecutionAgentEvents("exec-1");
		await service.listExecutionAgentEventsAfter({
			executionId: "exec-1",
			afterEventId: 7,
		});
		await service.listenSessionEventNotifications(() => undefined);
		await service.findSessionIdByDaprInstanceId("dapr-instance-1");
		await service.resolveSessionIdForProvisioningEvent({
			runtimeAppId: "runtime-app-1",
			sessionId: "label-session-1",
		});
		await service.getSessionFileOwner("session-1");
		await service.appendSessionEvent("session-1", {
			type: "workflow.state",
			data: { status: "COMPLETED" },
			sourceEventId: "dapr-wf-state:dapr-instance-1:event-1",
		});
		await service.upsertWorkflowArtifact({
			id: "artifact-1",
			workflowExecutionId: "exec-1",
			kind: "markdown",
			title: "Summary",
		});
		await service.getWorkflowArtifactForExecution({
			executionId: "exec-1",
			artifactId: "artifact-1",
		});
		await service.updateWorkflowArtifactMetadata({
			executionId: "exec-1",
			artifactId: "artifact-1",
			metadata: { promotion: { branch: "wfb-promote-1" } },
		});
		await service.mergeWorkflowArtifactMetadata({
			executionId: "exec-1",
			artifactId: "artifact-1",
			patch: { acceptance: { ok: true } },
		});
		await service.listSourceBundleArtifactsByWorkflowId("wf-1");
		await service.createWorkflowFile({
			userId: "user-1",
			projectId: "project-1",
			name: "artifact.bin",
			purpose: "output",
			scopeId: "exec-1",
			bytes: Buffer.from("payload"),
		});
		await service.listWorkflowFiles({
			userId: "user-1",
			purpose: "output",
			scopeId: "exec-1",
		});
		await service.getWorkflowFile("file-1");
		await service.getWorkflowFileContent("file-1");
		await service.archiveWorkflowFile({ id: "file-1", userId: "user-1" });
		await service.deleteWorkflowFile({ id: "file-1", userId: "user-1" });
		await service.persistRunDiffArtifact({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			nodeId: "agent",
			patch: "diff --git a/file b/file\n+hello\n",
		});
		await service.persistSourceBundleArtifact({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
			nodeId: "agent",
			bytes: Buffer.from("bundle"),
			meta: { base: "main", head: "HEAD" },
		});
		await service.upsertWorkflowWorkspaceSession({
			workspaceRef: "workspace-1",
			workflowExecutionId: "exec-1",
			name: "workspace_profile",
			rootPath: "/sandbox",
			backend: "openshell",
		});
		await service.listWorkflowWorkspaceSessionsByExecutionId({
			executionId: "exec-1",
			limit: 2,
		});
		await service.markWorkflowWorkspaceSessionCleaned({
			workspaceRef: "workspace-1",
		});

			expect(workflowExecutions.applyRuntimeProjection).toHaveBeenCalledWith("exec-1", {
				phase: "running",
			});
			expect(workflowExecutions.compareAndSetReadModel).toHaveBeenCalledWith({
				executionId: "exec-1",
				expectedStatus: "running",
				patch: { status: "success" },
			});
		expect(workflowExecutions.assertReadModelReady).toHaveBeenCalledTimes(1);
		expect(modelCatalog.listEnabledModelIds).toHaveBeenCalledTimes(1);
		expect(workflowExecutions.create).toHaveBeenCalledWith(
			expect.objectContaining({ id: "exec-1", workflowSessionId: "exec-1" }),
		);
		expect(workflowExecutions.attachSchedulerInstance).toHaveBeenCalledWith({
			executionId: "exec-1",
			instanceId: "sw-example-exec-exec-1",
			primaryTraceId: "trace-1",
		});
		expect(workflowExecutions.markStartFailed).toHaveBeenCalledWith({
			executionId: "exec-1",
			error: "failed to start",
		});
		expect(workflowExecutions.getByDaprInstanceId).toHaveBeenCalledWith(
			"sw-example-exec-exec-1",
		);
		expect(workflowExecutions.getExecutionWorkspaceKey).toHaveBeenCalledWith(
			"exec-1",
		);
    expect(workflowExecutions.getSessionOwnerContext).toHaveBeenCalledWith(
      "exec-1",
    );
    expect(workflowExecutions.getRunningByWorkflowId).toHaveBeenCalledWith(
      "wf-1",
    );
		expect(workflowExecutions.getLineage).toHaveBeenCalledWith("exec-1");
		expect(workflowExecutions.listActiveForUser).toHaveBeenCalledWith("user-1");
		expect(workflowExecutions.listForInternalAgent).toHaveBeenCalledWith({
			workflowId: "wf-1",
			workflowName: "Example",
			status: "running",
			limit: 25,
			offset: 5,
		});
		expect(workflowExecutions.listByWorkflowId).toHaveBeenCalledWith({
			workflowId: "wf-1",
			limit: 20,
			include: "summary",
		});
    expect(
      workflowExecutions.listRunSummariesByWorkflowId,
    ).toHaveBeenCalledWith({
			workflowId: "wf-1",
			limit: 20,
		});
		expect(workflowExecutions.listProjectRuns).toHaveBeenCalledWith({
			projectId: "project-1",
			workflowId: "wf-1",
			status: "running",
			since: new Date("2026-01-01T00:00:00.000Z"),
			q: "Example",
			limit: 10,
		});
    expect(
      workflowExecutions.listSessionsForExecutionLineage,
    ).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
			maxAncestors: 20,
		});
    expect(
      workflowExecutions.listOutputFilesByExecutionId,
    ).toHaveBeenCalledWith("exec-1");
    expect(
      workflowExecutions.aggregateUsageMetricsForExecutionLineage,
    ).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
			maxAncestors: 20,
		});
		expect(workflowExecutions.listStaleRunningExecutions).toHaveBeenCalledWith({
			olderThanMinutes: 60,
		});
		expect(workflowExecutions.appendLog).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-1", nodeId: "agent" }),
		);
    expect(workflowExecutions.updateLog).toHaveBeenCalledWith(
      "exec-1",
      "log-1",
      {
			status: "success",
      },
    );
    expect(workflowExecutions.listLogsByExecutionId).toHaveBeenCalledWith(
      "exec-1",
    );
    expect(workflowExecutions.listSessionIdsByExecutionId).toHaveBeenCalledWith(
      "exec-1",
    );
    expect(
      workflowExecutions.listAgentEventsByExecutionId,
    ).toHaveBeenCalledWith("exec-1");
    expect(
      workflowExecutions.listAgentEventsByExecutionIdAfter,
    ).toHaveBeenCalledWith({
			executionId: "exec-1",
			afterEventId: 7,
		});
    expect(sessionEventNotifications.listenSessionEvents).toHaveBeenCalledTimes(
      1,
    );
		expect(sessions.findSessionIdByDaprInstanceId).toHaveBeenCalledWith(
			"dapr-instance-1",
		);
		expect(sessions.resolveSessionIdForProvisioningEvent).toHaveBeenCalledWith({
			runtimeAppId: "runtime-app-1",
			sessionId: "label-session-1",
		});
		expect(sessions.getSessionFileOwner).toHaveBeenCalledWith("session-1");
		expect(sessionEvents.appendSessionEvent).toHaveBeenCalledWith("session-1", {
			type: "workflow.state",
			data: { status: "COMPLETED" },
			sourceEventId: "dapr-wf-state:dapr-instance-1:event-1",
		});
		expect(artifactStore.upsertWorkflowArtifact).toHaveBeenCalledWith(
			expect.objectContaining({ id: "artifact-1", kind: "markdown" }),
		);
		expect(artifactStore.getWorkflowArtifactForExecution).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
		});
		expect(artifactStore.updateWorkflowArtifactMetadata).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
			metadata: { promotion: { branch: "wfb-promote-1" } },
		});
		expect(artifactStore.mergeWorkflowArtifactMetadata).toHaveBeenCalledWith({
			executionId: "exec-1",
			artifactId: "artifact-1",
			patch: { acceptance: { ok: true } },
		});
    expect(
      artifactStore.listSourceBundleArtifactsByWorkflowId,
    ).toHaveBeenCalledWith("wf-1");
		expect(workflowFiles.createFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				projectId: "project-1",
				name: "artifact.bin",
				scopeId: "exec-1",
			}),
		);
		expect(workflowFiles.listFiles).toHaveBeenCalledWith({
			userId: "user-1",
			purpose: "output",
			scopeId: "exec-1",
		});
		expect(workflowFiles.getFile).toHaveBeenCalledWith("file-1");
		expect(workflowFiles.getFileContent).toHaveBeenCalledWith("file-1");
		expect(workflowFiles.archiveFile).toHaveBeenCalledWith({
			id: "file-1",
			userId: "user-1",
		});
		expect(workflowFiles.deleteFile).toHaveBeenCalledWith({
			id: "file-1",
			userId: "user-1",
		});
		expect(artifactStore.upsertWorkflowArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowExecutionId: "exec-1",
				kind: "diff",
				slot: "secondary",
			}),
		);
		expect(artifactStore.upsertWorkflowArtifact).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowExecutionId: "exec-1",
				kind: "source-bundle",
				slot: "aux",
				fileId: "file-1",
			}),
		);
    expect(
      workspaceSessions.upsertWorkflowWorkspaceSession,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRef: "workspace-1",
        backend: "openshell",
      }),
		);
		expect(
			workspaceSessions.listWorkflowWorkspaceSessionsByExecutionId,
		).toHaveBeenCalledWith({
			executionId: "exec-1",
			limit: 2,
		});
		expect(
			workspaceSessions.markWorkflowWorkspaceSessionCleaned,
		).toHaveBeenCalledWith({
			workspaceRef: "workspace-1",
		});
	});
});
