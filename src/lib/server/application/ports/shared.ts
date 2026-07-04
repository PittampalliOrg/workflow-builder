import type {
	PlatformOAuthAppMutationRecord,
	SettingsOAuthAppListItem,
	SettingsOAuthPieceRecord,
	SettingsPlatformOAuthAppRecord,
} from "./connections";
import type {
	ServiceGraphExecutionOption,
} from "./executions";
import type {
	ProjectMembershipRole,
	SettingsUserProfileRecord,
} from "./platform";
import type {
	ServiceGraphWorkflowOption,
} from "./workflows";

export type ServiceGraphPickerOptions = {
	workflows: ServiceGraphWorkflowOption[];
	executions: ServiceGraphExecutionOption[];
	defaultExecutionId: string;
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

export interface LifecycleCoordinatorCancelNotifier {
	scheduleCoordinatorCancel(kind: "benchmarkRun" | "evalRun", runId: string): void;
}

export type SettingsPageReadModel = {
	profile: SettingsUserProfileRecord | null;
	oauthApps: SettingsOAuthAppListItem[];
};

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

export type WorkspaceSummary = {
	id: string;
	displayName: string;
	externalId: string;
	slug: string;
	role: ProjectMembershipRole;
	isCurrent: boolean;
	createdAt: string;
};

export type EncryptedSecretValue = {
	iv: string;
	data: string;
};

export interface CodeFunctionCatalogRepository {
	listEnabledForCatalog(userId: string): Promise<CodeCatalogFunctionRecord[]>;
}

export interface ModelCatalogRepository {
	listEnabledModelIds(): Promise<string[]>;
}

export type SourceBundlePromotionMode = "pr" | "branch";

export type SourceBundlePromotionGateInput = {
	mode: SourceBundlePromotionMode;
	artifactPayload: Record<string, unknown>;
	executionOutput: unknown;
	summaryOutput: Record<string, unknown> | null;
};

export type SourceBundlePromotionGateResult = {
	allowed: boolean;
	[key: string]: unknown;
};

export interface SourceBundlePromotionGatePort {
	evaluatePromotionGate(
		input: SourceBundlePromotionGateInput,
	): SourceBundlePromotionGateResult;
}

export type SourceBundlePromotionRunnerInput = {
	executionId: string;
	fileId: string;
	repo: string;
	base: string;
	mode: SourceBundlePromotionMode;
	title: string;
	tier: string;
	repoSubdir: string;
	syncPaths: string[];
};

export type SourceBundlePromotionRunnerResult =
	| {
			status: "ok";
			output: string;
			prUrl: string | null;
			branch: string | null;
			prError: string | null;
	  }
	| { status: "command_error"; error: string; output: string }
	| { status: "unavailable"; message: string };

export interface SourceBundlePromotionRunnerPort {
	promoteSourceBundle(
		input: SourceBundlePromotionRunnerInput,
	): Promise<SourceBundlePromotionRunnerResult>;
}

export interface EventBus {
	publish(topic: string, payload: unknown): Promise<void>;
}

export type ResolveSecretOptions = {
	store?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
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
