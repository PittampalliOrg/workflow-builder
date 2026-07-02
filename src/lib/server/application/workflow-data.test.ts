import { describe, expect, it, vi } from "vitest";
import type {
	ApiKeyStore,
	AdminPieceRepository,
	AppConnectionRepository,
	ArtifactStore,
	BenchmarkBrowserRepository,
	HostedMcpServerRepository,
	McpConnectionRepository,
	McpConnectionRecord,
	McpRunRepository,
	SettingsRepository,
	TraceLineageStore,
	UsageReportingRepository,
	SandboxInventoryRepository,
	SandboxRuntimeInventory,
	CodeFunctionCatalogRepository,
	SessionEventLog,
	SessionRepository,
	WorkflowDefinition,
	WorkflowDefinitionRepository,
	WorkflowFileStore,
	PieceExecutionRepository,
	WorkflowTriggerStore,
	WorkflowAgentRunStore,
	WorkflowExecutionRepository,
	PieceCatalogRepository,
	UserProfileRepository,
	WorkflowPlanArtifactStore,
	WorkflowSessionEventNotificationSource,
	WorkflowScheduler,
	WorkspaceProjectRepository,
	WorkspaceSessionStore,
} from "$lib/server/application/ports";
import { ApplicationWorkflowDataService } from "$lib/server/application/workflow-data";

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
		value.data.startsWith("encrypted:") ? value.data.slice("encrypted:".length) : value.data,
	decryptObject: (value: { data: string }) =>
		JSON.parse(
			value.data.startsWith("encrypted:") ? value.data.slice("encrypted:".length) : value.data,
	),
}));

vi.mock("$env/dynamic/private", () => ({
	env: {},
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
		delete: vi.fn(async () => undefined),
	};
}

function fakeApiKeys(): ApiKeyStore {
	return {
		getByKeyHash: vi.fn(async () => null),
		markUsed: vi.fn(async () => undefined),
		listByUserId: vi.fn(async () => []),
		createUserApiKey: vi.fn(async (input) => ({
			id: input.id,
			name: input.name,
			keyPrefix: input.keyPrefix,
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			lastUsedAt: null,
		})),
		deleteForUser: vi.fn(async () => false),
		updateSecretForUser: vi.fn(async () => null),
	};
}

function fakeUserProfiles(): UserProfileRepository {
	return {
		getUserProfile: vi.fn(async () => null),
	};
}

function fakeSettings(): SettingsRepository {
	return {
		getSettingsUserProfile: vi.fn(async () => null),
		listPlatformOAuthApps: vi.fn(async () => []),
		listOAuthPieces: vi.fn(async () => []),
		resolvePlatformId: vi.fn(async (sessionPlatformId) => sessionPlatformId ?? "platform-1"),
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

function mcpConnection(overrides: Partial<McpConnectionRecord> = {}): McpConnectionRecord {
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
	return {
		assertReadModelReady: vi.fn(async () => undefined),
		getById: vi.fn(async () => null),
		getByDaprInstanceId: vi.fn(async () => null),
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
		updateReadModel: vi.fn(async () => undefined),
		appendLog: vi.fn(async () => executionLog),
		updateLog: vi.fn(async () => ({ ...executionLog, status: "success" as const })),
		listLogsByExecutionId: vi.fn(async () => [executionLog]),
		listSessionIdsByExecutionId: vi.fn(async () => ["session-1"]),
		countActiveTriggeredRuns: vi.fn(async () => 0),
		listAgentEventsByExecutionId: vi.fn(async () => []),
		listAgentEventsByExecutionIdAfter: vi.fn(async () => []),
	};
}

function fakeWorkflowScheduler(): WorkflowScheduler {
	return {
		startSwWorkflow: vi.fn(async () => ({
			instanceId: "sw-example-exec-exec-1",
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
		getFileContent: vi.fn(async () => ({ summary: file, bytes: Buffer.from("payload") })),
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
		setPieceEnabled: vi.fn(async () => undefined),
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
		getSession: vi.fn(async () => null),
		findSessionIdByDaprInstanceId: vi.fn(async () => "session-1"),
		resolveSessionIdForProvisioningEvent: vi.fn(async () => "session-1"),
		getSessionFileOwner: vi.fn(async () => ({
			id: "session-1",
			userId: "user-1",
			projectId: "project-1",
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
	};
}

function fakeWorkspaceProjects(): WorkspaceProjectRepository {
	const createdAt = new Date("2026-01-01T00:00:00.000Z");
	const updatedAt = new Date("2026-01-01T00:00:00.000Z");
	return {
		getMemberProjectId: vi.fn(async () => "project-1"),
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
		findPlatformUserForProject: vi.fn(async () => ({ ok: true as const, userId: "user-2" })),
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
	pieceExecutions?: PieceExecutionRepository;
}) {
	const workflowDefinitions = {
		getById: vi.fn(async () => options.byId ?? null),
		getLatestByName: vi.fn(async () => options.byName ?? null),
		getByRef: vi.fn(async () => null),
		list: vi.fn(async () => []),
		listForWorkspace: vi.fn(async () => []),
		findProjectWorkflowIdByIdOrNamePrefix: vi.fn(async () => null),
		create: vi.fn(async () => baseWorkflow),
		update: vi.fn(async () => baseWorkflow),
		hasActiveExecutions: vi.fn(async () => false),
		delete: vi.fn(async () => undefined),
	} satisfies WorkflowDefinitionRepository;
	const workflowTriggers = fakeWorkflowTriggers();
	const workflowExecutions = (options.workflowExecutions ?? {}) as WorkflowExecutionRepository;

	const service = new ApplicationWorkflowDataService({
		workflowDefinitions,
		workflowTriggers,
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
		pieceExecutions: options.pieceExecutions,
		benchmarkBrowser: fakeBenchmarkBrowser(),
		workflowExecutions,
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

function makeServiceWithWorkspaceProjects(workspaceProjects: WorkspaceProjectRepository) {
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

function makeServiceWithUsageReporting(usageReporting: UsageReportingRepository) {
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

	it("delegates workflow definition commands to the workflow definition port", async () => {
		const { service, workflowDefinitions } = makeService({
			byId: baseWorkflow,
		});

		await service.listWorkflows({ limit: 50, projectId: "project-1" });
		await service.findProjectWorkflowIdByIdOrNamePrefix({
			projectId: "project-1",
			workflowId: "microservice-dev-session",
			namePrefix: "Microservice dev-session%",
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
		expect(workflowDefinitions.findProjectWorkflowIdByIdOrNamePrefix).toHaveBeenCalledWith({
			projectId: "project-1",
			workflowId: "microservice-dev-session",
			namePrefix: "Microservice dev-session%",
		});
		expect(workflowDefinitions.create).toHaveBeenCalledWith(
			expect.objectContaining({ name: "New workflow", engineType: "dapr" }),
		);
		expect(workflowDefinitions.update).toHaveBeenCalledWith("wf-id", {
			name: "Updated",
			nodes: [],
			edges: [],
		});
		expect(workflowDefinitions.hasActiveExecutions).toHaveBeenCalledWith("wf-id");
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

		await expect(service.getWorkflowTriggerById("trigger-1")).resolves.toEqual(trigger);
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
			service.countActiveTriggeredWorkflowRuns({ statuses: ["pending", "running"] }),
		).resolves.toBe(7);
		expect(workflowExecutions.countActiveTriggeredRuns).toHaveBeenCalledWith({
			statuses: ["pending", "running"],
		});
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

		await expect(service.getPieceExecutionByIdempotencyKey("wf:exec:task")).resolves.toEqual(
			pieceExecution,
		);
		expect(pieceExecutions.getByIdempotencyKey).toHaveBeenCalledWith("wf:exec:task");
	});

	it("loads user profile data through the user profile port", async () => {
		const userProfiles = {
			getUserProfile: vi.fn(async () => ({
				name: "Ada",
				email: "ada@example.test",
				image: null,
				platformRole: "ADMIN" as const,
			})),
		} satisfies UserProfileRepository;
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
		expect(userProfiles.getUserProfile).toHaveBeenCalledWith("user-1");
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
			resolvePlatformId: vi.fn(async (sessionPlatformId) => sessionPlatformId ?? "platform-1"),
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
		expect(settings.listPlatformOAuthApps).toHaveBeenCalledWith("platform-session");
		expect(settings.listOAuthPieces).toHaveBeenCalled();
	});

	it("saves and deletes platform OAuth apps through settings ports", async () => {
		const settings = {
			...fakeSettings(),
			resolvePlatformId: vi.fn(async (sessionPlatformId) => sessionPlatformId ?? "platform-1"),
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

		expect(mcpConnections.activeAppConnectionExistsForPiece).toHaveBeenCalledWith({
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
			service.deleteProjectMcpConnection({ id: "hosted-1", projectId: "project-1" }),
		).resolves.toEqual({
			ok: false,
			status: 400,
			message: "Cannot delete hosted workflow connections",
		});
		await expect(
			service.deleteProjectMcpConnection({ id: "custom-1", projectId: "project-1" }),
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
						toolNames: ["create_issue", { name: "list_issues" }, "create_issue"],
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

		await expect(service.listConnectablePieces({ authOnly: true })).resolves.toEqual([
			{
				name: "@activepieces/piece-github",
				displayName: "GitHub",
				logoUrl: "https://example.test/github.svg",
				authType: "OAUTH2",
			},
		]);
		expect(pieceCatalog.listConnectablePieces).toHaveBeenCalledWith({ authOnly: true });
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

		await expect(service.listCatalogFunctions({ userId: "user-1" })).resolves.toEqual({
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
		expect(codeFunctionCatalog.listEnabledForCatalog).toHaveBeenCalledWith("user-1");
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

		await expect(service.listCatalogFunctions({ userId: null })).resolves.toEqual({
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
		const service = makeServiceWithHostedMcp(hostedMcpServers, workspaceProjects);

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
		expect(hostedMcpServers.listWorkflowSourcesForProject).toHaveBeenCalledWith({
			projectId: "project-1",
			ownerId: "owner-1",
		});
		expect(hostedMcpServers.upsertHostedWorkflowConnection).toHaveBeenCalledWith(
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
		expect(hostedMcpServers.upsertHostedWorkflowConnection).not.toHaveBeenCalled();
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
		if (!result.ok) throw new Error("expected hosted MCP token rotation to succeed");
		expect(result.server.token).toMatch(/^[0-9a-z]{72}$/);
		expect(hostedMcpServers.updateServerToken).toHaveBeenCalledWith({
			id: "mcp-server-1",
			tokenEncrypted: {
				iv: "test-iv",
				data: expect.stringMatching(/^encrypted:[0-9a-z]{72}$/),
			},
		});
		expect(hostedMcpServers.upsertHostedWorkflowConnection).toHaveBeenCalledWith(
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
		expect(hostedMcpServers.getProjectOwnerId).toHaveBeenCalledWith("project-1");
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
		expect(hostedMcpServers.resolveProjectByIdOrExternalId).toHaveBeenCalledWith(
			"workspace-1",
		);
		expect(hostedMcpServers.upsertHostedWorkflowConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "project-1",
				status: "ENABLED",
			}),
		);
		expect(mcpConnections.listProjectConnections).toHaveBeenCalledWith("project-1");
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

		expect(workflowExecutions.updateReadModel).toHaveBeenCalledWith("exec-1", {
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

		expect(workflowExecutions.updateReadModel).toHaveBeenCalledWith("exec-1", {
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
		expect(appConnections.listProjectConnections).toHaveBeenCalledWith("project-1");
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
		const fetchSpy = vi.fn(async () =>
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
				defaultRedirectUrl: "https://app.example/api/app-connections/oauth2/callback",
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
		const fetchSpy = vi.fn(async () =>
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
					data:
						'encrypted:{"type":"PLATFORM_OAUTH2","access_token":"old-access","refresh_token":"refresh-1","token_url":"https://github.example/token","client_id":"client-1","claimed_at":1,"expires_in":1}',
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
		if (result.ok) expect(result.connection.value.expiry_date).toEqual(expect.any(Number));
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
			setPieceEnabled: vi.fn(async () => undefined),
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

	it("resolves workspace project membership through the workspace project port", async () => {
		const workspaceProjects = {
			...fakeWorkspaceProjects(),
			getMemberProjectId: vi.fn(async () => "project-current"),
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
		await expect(service.getWorkspaceProjectExternalId("project-1")).resolves.toBe(
			"workspace-slug",
		);
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

		expect(workspaceProjects.getMemberProjectId).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
		expect(workspaceProjects.getMemberProjectIdBySlug).toHaveBeenCalledWith({
			slug: "workspace-slug",
			userId: "user-1",
		});
		expect(workspaceProjects.getProjectExternalId).toHaveBeenCalledWith("project-1");
		expect(workspaceProjects.getProjectMembershipDetail).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});
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
		expect(workspaceProjects.listProjectMembers).toHaveBeenCalledWith("project-1");
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
		const duplicateService = makeServiceWithWorkspaceProjects(duplicateProjects);
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
		const crossPlatformService = makeServiceWithWorkspaceProjects(crossPlatformProjects);
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
		expect(result.priceBook.some((row) => row.model === "claude-opus-4-8")).toBe(true);
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

		await expect(service.listSandboxExecutions("dapr-agent-py")).resolves.toEqual([
			{
				executionId: "exec-1",
				workflowId: "wf-1",
				workflowName: "Unknown",
				status: "completed",
				startedAt: "2026-07-01T00:00:00.000Z",
				completedAt: null,
			},
		]);
		expect(sandboxInventory.listRecentExecutionsForSandbox).toHaveBeenCalledWith(
			"dapr-agent-py",
		);
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
		expect(workflowExecutions.listRecentRunsByWorkflowIds).toHaveBeenCalledWith({
			workflowIds: ["wf-idle", "wf-running"],
			limitPerWorkflow: 3,
		});
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
				},
			],
			defaultExecutionId: "exec-1",
		});
		expect(workflowDefinitions.listForWorkspace).toHaveBeenCalledWith({
			limit: 200,
			userId: "user-1",
			projectId: "project-1",
		});
		expect(workflowExecutions.listRecentExecutionPickerRecords).toHaveBeenCalledWith({
			limit: 50,
			userId: "user-1",
			projectId: "project-1",
		});
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
			repoFacets: [{ value: "django/django", label: "django/django", count: 1 }],
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
			getByKeyHash: vi.fn(async () => ({ id: "key-1", userId: "user-1" })),
			markUsed: vi.fn(async () => undefined),
		} satisfies ApiKeyStore;
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
	});

	it("manages user API keys through the API-key port", async () => {
		const apiKeys = {
			...fakeApiKeys(),
			listByUserId: vi.fn(async () => [
				{
					id: "key-1",
					name: "Webhook",
					keyPrefix: "wfb_abc...",
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					lastUsedAt: null,
				},
			]),
			createUserApiKey: vi.fn(async (input) => ({
				id: input.id,
				name: input.name,
				keyPrefix: input.keyPrefix,
				createdAt: new Date("2026-01-02T00:00:00.000Z"),
				lastUsedAt: null,
			})),
			deleteForUser: vi.fn(async () => true),
			updateSecretForUser: vi.fn(async (input) => ({
				id: input.id,
				name: "Webhook",
				keyPrefix: input.keyPrefix,
				createdAt: new Date("2026-01-02T00:00:00.000Z"),
				lastUsedAt: null,
			})),
		} satisfies ApiKeyStore;
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

		await expect(service.listUserApiKeys("user-1")).resolves.toHaveLength(1);
		await expect(
			service.createUserApiKey({ userId: "user-1", name: " Webhook " }),
		).resolves.toMatchObject({
			name: "Webhook",
			keyPrefix: expect.stringMatching(/^wfb_/),
			key: expect.stringMatching(/^wfb_/),
		});
		await expect(
			service.rotateUserApiKey({ userId: "user-1", keyId: "key-1" }),
		).resolves.toMatchObject({
			id: "key-1",
			keyPrefix: expect.stringMatching(/^wfb_/),
			key: expect.stringMatching(/^wfb_/),
		});
		await expect(
			service.deleteUserApiKey({ userId: "user-1", keyId: "key-1" }),
		).resolves.toBe(true);

		expect(apiKeys.createUserApiKey).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				name: "Webhook",
				keyHash: expect.any(String),
				keyPrefix: expect.stringMatching(/^wfb_/),
			}),
		);
		expect(apiKeys.updateSecretForUser).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "key-1",
				userId: "user-1",
				keyHash: expect.any(String),
				keyPrefix: expect.stringMatching(/^wfb_/),
			}),
		);
		expect(apiKeys.deleteForUser).toHaveBeenCalledWith({
			id: "key-1",
			userId: "user-1",
		});
	});

	it("delegates agent-run lifecycle operations to the agent-run port", async () => {
		const agentRuns = {
			upsertScheduledAgentRun: vi.fn(async () => ({ id: "agent-run-1" })),
			updateAgentRunLifecycle: vi.fn(async () => ({
				id: "agent-run-1",
				status: "completed" as const,
			})),
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
		expect(planArtifacts.listPlanArtifactsByExecutionId).toHaveBeenCalledWith("exec-1");
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
			listByWorkflowId: vi.fn(async () => []),
			listRunSummariesByWorkflowId: vi.fn(async () => []),
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
			updateReadModel: vi.fn(async () => undefined),
			appendLog: vi.fn(async () => executionLog),
			updateLog: vi.fn(async () => ({ ...executionLog, status: "success" as const })),
			listLogsByExecutionId: vi.fn(async () => [executionLog]),
			listSessionIdsByExecutionId: vi.fn(async () => ["session-1"]),
			countActiveTriggeredRuns: vi.fn(async () => 0),
			listAgentEventsByExecutionId: vi.fn(async () => []),
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
		} satisfies ArtifactStore;
		const workflowFiles = fakeWorkflowFiles();
		const workspaceSessions = {
			upsertWorkflowWorkspaceSession: vi.fn(async () => ({
				workspaceRef: "workspace-1",
			})),
		} satisfies WorkspaceSessionStore;
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

		await service.updateExecutionReadModel("exec-1", { phase: "running" });
		await service.assertExecutionReadModelReady();
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
		await service.listSourceBundleArtifactsByWorkflowId("wf-1");
		await service.createWorkflowFile({
			userId: "user-1",
			projectId: "project-1",
			name: "artifact.bin",
			purpose: "output",
			scopeId: "exec-1",
			bytes: Buffer.from("payload"),
		});
		await service.getWorkflowFileContent("file-1");
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

		expect(workflowExecutions.updateReadModel).toHaveBeenCalledWith("exec-1", {
			phase: "running",
		});
		expect(workflowExecutions.assertReadModelReady).toHaveBeenCalledTimes(1);
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
		expect(workflowExecutions.getRunningByWorkflowId).toHaveBeenCalledWith("wf-1");
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
		expect(workflowExecutions.listRunSummariesByWorkflowId).toHaveBeenCalledWith({
			workflowId: "wf-1",
			limit: 20,
		});
		expect(workflowExecutions.listSessionsForExecutionLineage).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
			maxAncestors: 20,
		});
		expect(workflowExecutions.listOutputFilesByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(workflowExecutions.aggregateUsageMetricsForExecutionLineage).toHaveBeenCalledWith({
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
		expect(workflowExecutions.updateLog).toHaveBeenCalledWith("exec-1", "log-1", {
			status: "success",
		});
		expect(workflowExecutions.listLogsByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(workflowExecutions.listSessionIdsByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(workflowExecutions.listAgentEventsByExecutionId).toHaveBeenCalledWith("exec-1");
		expect(workflowExecutions.listAgentEventsByExecutionIdAfter).toHaveBeenCalledWith({
			executionId: "exec-1",
			afterEventId: 7,
		});
		expect(sessionEventNotifications.listenSessionEvents).toHaveBeenCalledTimes(1);
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
		expect(artifactStore.listSourceBundleArtifactsByWorkflowId).toHaveBeenCalledWith("wf-1");
		expect(workflowFiles.createFile).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				projectId: "project-1",
				name: "artifact.bin",
				scopeId: "exec-1",
			}),
		);
		expect(workflowFiles.getFileContent).toHaveBeenCalledWith("file-1");
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
		expect(workspaceSessions.upsertWorkflowWorkspaceSession).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceRef: "workspace-1", backend: "openshell" }),
		);
	});
});
