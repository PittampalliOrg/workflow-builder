import type {
	AgentSkillUsedByReadModel,
	PromptPresetAgentUsageReadModel,
	UsageAnalyticsAgentRecord,
	VaultUsageAgentReadModel,
} from "./agents";
import type {
	DashboardActiveSessionReadModel,
	HomePageRecentSessionReadModel,
	HomePageRecentSessionRecord,
} from "./sessions";

export type PromptPresetUsageBindingKind = "static" | "dynamic";

export type PromptPresetUsagesReadModel = {
	usages: PromptPresetAgentUsageReadModel[];
	latestVersion: number;
};

export type VaultUsagesReadModel = {
	agents: VaultUsageAgentReadModel[];
	sessionCount: number;
};

export interface ResourceUsageReadRepository {
	getPromptPresetUsages(input: {
		presetId: string;
		projectId: string;
	}): Promise<PromptPresetUsagesReadModel | null>;
	listAgentSkillUsedBy(input: {
		skillRef: string;
		projectId?: string | null;
		limit: number;
	}): Promise<AgentSkillUsedByReadModel | null>;
	getVaultUsages(input: {
		vaultId: string;
	}): Promise<VaultUsagesReadModel>;
}

export type SecurityAuditEventKind =
	| "credential.access"
	| "member.added"
	| "config.change";

export type SecurityAuditEventReadModel = {
	id: string;
	at: string;
	kind: SecurityAuditEventKind;
	summary: string;
	executionId?: string | null;
	actor?: string | null;
};

export type SecurityAuditReadModel = {
	events: SecurityAuditEventReadModel[];
	asOf: string;
};

export interface SecurityAuditReadRepository {
	getSecurityAudit(input: {
		projectId?: string | null;
		since: Date;
		now: Date;
		limit: number;
	}): Promise<SecurityAuditReadModel>;
}

export type DashboardStatsReadModel = {
	activeSessions: number;
	sessionsToday: number;
	archivedLast24h: number;
	tokensOut7d: number;
	tokensIn7d: number;
	totalAgents: number;
	totalEnvironments: number;
	totalVaults: number;
};

export type DashboardRecentChangeReadModel = {
	kind: "agent" | "environment";
	resourceId: string;
	resourceName: string;
	version: number;
	publishedAt: string | null;
};

export type DashboardReadModel = {
	stats: DashboardStatsReadModel;
	activeSessions: DashboardActiveSessionReadModel[];
	recentChanges: DashboardRecentChangeReadModel[];
};

export interface DashboardReadRepository {
	getDashboard(input: {
		userId: string;
		now: Date;
	}): Promise<DashboardReadModel>;
}

export type HomePageUserReadModel = {
	name: string | null;
	email: string | null;
};

export type HomePageRecentRunReadModel = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: string;
	startedAt: string;
	durationMs: number | null;
};

export type HomePageReadModel = {
	user: HomePageUserReadModel | null;
	recentSessions: HomePageRecentSessionReadModel[];
	recentRuns: HomePageRecentRunReadModel[];
};

export type HomePageRecentRunRecord = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: string;
	startedAt: Date;
	duration: string | null;
};

export interface HomePageReadRepository {
	listRecentHomeSessions(input: {
		userId: string;
		projectId?: string | null;
		limit: number;
	}): Promise<HomePageRecentSessionRecord[]>;
	listRecentHomeRuns(input: {
		projectId: string;
		limit: number;
	}): Promise<HomePageRecentRunRecord[]>;
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

export type ProjectMembershipRole = "ADMIN" | "EDITOR" | "OPERATOR" | "VIEWER";

export type WorkspaceProjectMembershipRecord = {
	id: string;
	displayName: string;
	externalId: string;
	role: ProjectMembershipRole;
	createdAt: Date;
};

export type CreateWorkspaceProjectInput = {
	platformId: string;
	ownerId: string;
	displayName: string;
	externalId: string;
};

export interface WorkspaceProjectRepository {
	getMemberProjectId(input: {
		projectId: string;
		userId: string;
	}): Promise<string | null>;
	getFallbackMemberProjectId(userId: string): Promise<string | null>;
	listWorkspaceMemberships(input: {
		userId: string;
	}): Promise<WorkspaceProjectMembershipRecord[]>;
	createWorkspaceProject(
		input: CreateWorkspaceProjectInput,
	): Promise<WorkspaceProjectMembershipRecord>;
	updateWorkspaceDisplayName(input: {
		projectId: string;
		displayName: string;
	}): Promise<boolean>;
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
