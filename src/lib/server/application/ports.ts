import type { AgentMcpResolutionResult } from "$lib/server/agents/mcp-resolution";
import type { AgentConfig } from "$lib/types/agents";
import type {
	SandboxProvisionInput,
	SandboxProvisionResult,
} from "$lib/server/sandboxes/provision";
import type {
	DevPreviewInfo,
	ProvisionDevPreviewParams,
} from "$lib/server/workflows/dev-preview";
import type {
	BenchmarkInstanceRow,
	RepoFacet,
	RunnableAgent,
	SuiteFacet,
} from "$lib/types/benchmark-instance";
import type {
	SessionDetail,
	SessionEventEnvelope,
	SessionStatus,
	SessionStopReason,
	SessionUsage,
} from "$lib/types/sessions";

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

export interface WorkflowBrowserArtifactStore {
	save(input: SaveWorkflowBrowserArtifactInput): Promise<WorkflowBrowserArtifactRecord>;
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

export type ProjectMembershipRole = "ADMIN" | "EDITOR" | "OPERATOR" | "VIEWER";

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
	getFileContent(id: string): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
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

export interface PeerAgentResolver {
	resolvePeerAgentOwner(peerAgentId: string): Promise<PeerAgentOwner | null>;
	resolvePeerAgentDispatchContext(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<PeerAgentDispatchContext | null>;
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

export interface SessionEventLog {
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope>;
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

export interface WorkflowCodeCheckpointStore {
	persistFromAgentEvent(input: PersistCodeCheckpointInput): Promise<void>;
}

export interface EvaluationArtifactStore {
	recordCodeCheckpointWarning(input: {
		workflowExecutionId: string;
		sourceEventId: string;
		checkpoint: Record<string, unknown>;
	}): Promise<void>;
}

export interface SessionTraceLifecycleStore {
	patchInteractiveSessionTraces(input: {
		sessionId: string;
		status: "OK" | "ERROR";
	}): Promise<void>;
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
	resolveWorkspaceProjectId(input: {
		slug?: string | null;
		userId: string;
		currentProjectId: string;
	}): Promise<string | null>;
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
	saveWorkflowBrowserArtifact(
		input: SaveWorkflowBrowserArtifactInput,
	): Promise<WorkflowBrowserArtifactRecord>;
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
	ingestSessionEvent(input: IngestSessionEventInput): Promise<IngestSessionEventResult>;
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
	getWorkflowFileContent(
		id: string,
	): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
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
