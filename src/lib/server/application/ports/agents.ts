import type {
	AgentConfig,
	AgentDetail,
	AgentRuntime,
	AgentSummary,
	AgentVersionSummary,
} from "$lib/types/agents";
import type {
	WorkflowExecutionAgentRunRecord,
} from "./executions";
import type {
	PromptPresetUsageBindingKind,
} from "./platform";
import type {
	SessionBrowserState,
	SessionControlSettingsReferences,
	SessionRuntimeCliAuthReadModel,
} from "./sessions";

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

export type PromptPresetAgentUsageReadModel = {
	id: string;
	slug: string;
	name: string;
	bindingKind: PromptPresetUsageBindingKind;
	version: number;
	latestVersion: number;
	isStale: boolean;
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

export type AgentSkillHydrationEntry = {
	id: string;
	prompt: string | null;
	allowedTools: string[] | null;
	description: string | null;
	whenToUse: string | null;
	arguments: string[] | null;
	argumentHint: string | null;
	model: string | null;
	packageManifest: Record<string, unknown> | null;
	skillName: string | null;
	slug: string | null;
	version: string | null;
};

export interface AgentSkillHydrationRepository {
	listAgentSkillHydrationEntries(
		ids: string[],
	): Promise<AgentSkillHydrationEntry[]>;
}

export type VaultUsageAgentReadModel = {
	id: string;
	slug: string;
	name: string;
	avatar: string | null;
	isArchived: boolean;
};

export type ProjectWorkflowRunAgent = {
	id: string;
	name: string;
	avatar: string | null;
	slug: string | null;
};

export type UsageAnalyticsAgentRecord = {
	agentId: string;
	agentName: string | null;
	tokensIn: number;
	tokensOut: number;
	sessions: number;
};

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
	listByWorkflowExecutionId(
		workflowExecutionId: string,
	): Promise<WorkflowExecutionAgentRunRecord[]>;
}

export interface LegacyAgentPlanReaderPort {
	getPlan(executionId: string): Promise<string | null>;
}

export type WorkflowRuntimeStatusSnapshot = {
	runtimeStatus: string | null;
	phase: string | null;
	progress: number | null;
	currentNodeId: string | null;
	currentNodeName: string | null;
	traceId: string | null;
	outputs: unknown;
	error: string | null;
	completedAt: string | null;
};

export interface WorkflowRuntimeStatusPort {
	getWorkflowStatus(instanceId: string): Promise<WorkflowRuntimeStatusSnapshot | null>;
}

export interface BrowserRuntimeClient {
	getState(input: {
		agentSlug: string;
	}): Promise<Omit<SessionBrowserState, "lastUpdatedAt"> | null>;
	takeScreenshot(input: { agentSlug: string }): Promise<{ jpeg: Uint8Array } | null>;
}

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

export type RuntimeStructuredOutputCapability = {
	mode: "tool";
	jsonSchemaDraft: "2020-12";
};

export interface RuntimeRegistryReader {
	listSessionRuntimeCliAuth(): Promise<
		Record<string, SessionRuntimeCliAuthReadModel>
	>;
	getStructuredOutputCapability(
		runtimeId: string,
	): Promise<RuntimeStructuredOutputCapability | null>;
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
	environmentId?: string | null;
	environmentVersion?: number | null;
	defaultVaultIds?: string[];
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
