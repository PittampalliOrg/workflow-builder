import type {
	AgentMcpResolutionResult,
} from "$lib/server/agents/mcp-resolution";
import type {
	McpServerAvailabilityEntry,
} from "$lib/server/mcp-catalog";
import type {
	AgentConfig,
} from "$lib/types/agents";
import type {
	EncryptedSecretValue,
} from "./shared";

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

export type WorkflowMcpResolutionResult = AgentMcpResolutionResult & {
	projectId: string | null;
};

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
