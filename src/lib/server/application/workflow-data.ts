import { createHash, randomBytes } from "node:crypto";
import { env } from "$env/dynamic/private";
import { agentModelOptionFor } from "$lib/agents/model-options";
import { pieceActionsFromMetadata } from "$lib/connections/piece-tools";
import type { McpServerProfileConfig } from "$lib/server/agent-profiles";
import { resolveMcpServerConfigsFromRows } from "$lib/server/agents/mcp-resolution";
import { buildProjectMcpCatalogEntry } from "$lib/server/mcp-catalog";
import { resolveAgentRuntimeRoute } from "$lib/server/agents/runtime-routing";
import { benchmarkRuntimeSupportsProvider } from "$lib/server/benchmarks/agents";
import { benchmarkExecutionBackend } from "$lib/server/benchmarks/execution-plane";
import {
	isExactValidatedSwebenchInferenceEnvironment,
	loadSwebenchInferenceEnvironmentMappings,
	resolveSwebenchInferenceEnvironment,
} from "$lib/server/benchmarks/inference-environments";
import { normalizeSwebenchSuiteSlug } from "$lib/server/benchmarks/swebench";
import { estimateBenchmarkRuntimeCapacity } from "$lib/server/benchmarks/runtime-capacity";
import { buildSwebenchEnvironmentSpec } from "$lib/server/environments/environment-image-builds";
import { connectionBelongsToProject, mergeConnectionProjectId } from "$lib/server/app-connection-scope";
import {
	buildOAuth2AuthorizationUrl,
	exchangeOAuth2CodePlatform,
	generateOAuthState,
	generatePkceChallenge,
	generatePkceVerifier,
	getOAuth2AuthConfig,
	resolveValueFromProps,
	type OAuth2AuthorizationMethod,
} from "$lib/server/app-connections/oauth2";
import { getOrchestratorUrl } from "$lib/server/dapr-client";
import {
	buildMcpAvailability,
	getMcpAvailabilityOAuthPieceNames,
	getMcpAvailabilityWantedPieceNames,
	loadRegisteredPieceMcpCatalog,
} from "$lib/server/mcp-availability";
import { costFor, MODEL_PRICING } from "$lib/server/pricing/model-pricing";
import { persistRunDiff } from "$lib/server/workflows/run-diff";
import { persistSourceBundle } from "$lib/server/workflows/source-bundle";
import {
	decryptObject,
	decryptString,
	encryptObject,
	encryptString,
	type EncryptedObject,
} from "$lib/server/security/encryption";
import {
	AppConnectionScope,
	AppConnectionStatus,
	AppConnectionType,
} from "$lib/server/types/app-connection";
import { generateId } from "$lib/server/utils/id";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeInvokeTarget,
} from "$lib/server/agents/runtime-routing";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { expandGreenfieldPromptInput } from "$lib/server/workflows/greenfield-prompt";
import { getMissingRequiredTriggerFields } from "$lib/server/workflows/trigger-validation";
import { isAgentConfigEquivalent } from "$lib/utils/agent-config-diff";
import { buildGoalFlowFromRecords } from "$lib/server/observability/goal-flow";
import { ApplicationBenchmarkEvaluationResultsService } from "$lib/server/application/benchmark-evaluation-results";
import type {
	AppendWorkflowExecutionLogInput,
	AdminPiecesReadModel,
	AdminPieceRepository,
	AddSessionResourceInput,
	AppConnectionCreateInput,
	AppConnectionListItem,
	AppConnectionRepository,
	AppConnectionSummary,
	ApiKeyStore,
	AppendSessionEventInput,
	ArtifactStore,
	BenchmarkArtifactMetadataInput,
	BenchmarkArtifactMetadataRepository,
	BenchmarkDatasetPromotionRepository,
	BenchmarkEvaluationEventNotifier,
	BenchmarkEvaluationIngestResult,
	BenchmarkEvaluationResultRepository,
	BenchmarkEvaluationResultsCallbackInput,
	BenchmarkEvaluationTelemetryPort,
	BenchmarkInstanceAnnotationVerdict,
	BenchmarkBrowserEnvironmentBuildRecord,
	BenchmarkInstanceDetailReadRepository,
	BenchmarkBrowserReadModel,
	BenchmarkBrowserRepository,
	BenchmarkRunInstanceDetailReadRepository,
	BenchmarkRunInstanceAnnotationRepository,
	BenchmarkRunInstanceProgressReadRepository,
	BenchmarkRunInstanceScoreReadRepository,
	BenchmarkRunReadRepository,
	BenchmarkRunLifecyclePort,
	BenchmarkRunRepository,
	BenchmarkSessionProvisioningGateResult,
	CreateProjectMcpConnectionInput,
	DevEnvironmentReadRepository,
	CreateWorkflowEnsureSessionInput,
	CreateWorkflowDefinitionInput,
	CreateWorkflowTriggerInput,
	CreateWorkflowExecutionInput,
	EvaluationArtifactStore,
	EnsurePeerSessionInput,
	EnsurePeerSessionResult,
	ExecutionWorkspaceRouteInfo,
	GoalFlowReadStore,
	HostedMcpInputProperty,
	HostedMcpServerReadModel,
	HostedMcpServerRecord,
	HostedMcpServerRepository,
	HomePageReadModel,
	HomePageReadRepository,
	HostedMcpServerStatus,
	HostedMcpWorkflow,
	McpAvailabilityReadModel,
	McpCatalogConfiguredConnectionSummary,
	McpRunRepository,
	ModelCatalogRepository,
	ObservabilityTraceGoalChipReadModel,
	ObservabilityTraceRepository,
	ObservabilityTraceScopeReadModel,
	ObservabilityServiceGraphWorkflowReadModel,
	ProjectMembershipRole,
	StartHostedMcpWorkflowToolInput,
	StartHostedMcpWorkflowToolResult,
	WorkflowArtifactInput,
	WorkflowActivityRateTargetReadModel,
	WorkflowActivityRateTargetRepository,
	WorkflowMonitorFallbackExecutionReadModel,
	WorkflowMonitorReadRepository,
	CreateWorkflowFileInput,
	CliWorkspaceCommandCandidate,
	IngestSessionEventInput,
	IngestSessionEventResult,
	ListSessionEventsInput,
	PersistWorkflowRunDiffInput,
	PersistWorkflowSourceBundleInput,
	WorkflowDataService,
	WorkflowDefinitionRepository,
	WorkflowTriggerStore,
	UserProfileRepository,
	WorkflowExecutionLogPatch,
	WorkflowExecutionReadModelPatch,
	WorkflowExecutionRepository,
	WorkflowExecutionRecord,
	WorkflowExecutionScopeInput,
	WorkflowExecutionStatus,
	WorkflowSessionEventNotification,
	WorkflowSessionEventNotificationSource,
	WorkflowAgentRunStore,
	WorkflowCodeCheckpointStore,
	UpdateWorkflowAgentRunLifecycleInput,
	UpsertWorkflowAgentRunScheduledInput,
	WorkflowPlanArtifactInput,
	WorkflowPlanArtifactStatus,
	WorkflowPlanArtifactStore,
	WorkflowRef,
	UsageReportingRepository,
	SandboxInventoryRepository,
	SandboxRuntimeInventory,
	SessionAgentConfigCommandPort,
	SessionAgentConfigPatchResult,
	SessionEventLog,
	SessionExperimentAgentStore,
	SessionRepository,
	SessionRuntimeConfigReader,
	SessionRuntimeEventRaiser,
	SessionRuntimeStatusReader,
	SessionTraceLifecycleStore,
	TraceLineageStore,
	UpdateWorkflowDefinitionInput,
	UpdateWorkflowEnsureSessionRuntimeInput,
	UpsertTraceLineageLinksInput,
	RuntimeRegistryReader,
	ResourceUsageReadRepository,
	SecurityAuditReadRepository,
	DashboardReadRepository,
	WorkflowAiAssistantMessageRepository,
	WorkspaceSessionStore,
	ServiceGraphPickerOptions,
	WorkspaceWorkflowListItem,
	WorkspaceSummary,
	WorkspaceProjectMembershipRecord,
	WorkspaceProjectRepository,
	PieceCatalogDetail,
	PieceCatalogRepository,
	PieceExecutionReadModel,
	PieceExecutionRepository,
	SessionBrowserTarget,
	SaveWorkflowBrowserArtifactInput,
	SessionProvisioningReader,
	WorkflowBrowserBlobPayload,
	WorkflowBrowserArtifactRecord,
	WorkflowBrowserArtifactStore,
	McpConnectionRepository,
	PeerAgentDispatchContext,
	PeerAgentResolver,
	WorkflowAgentReadRepository,
	WorkflowAgentRuntimeIdentity,
	WorkflowPublishedAgentResolutionResult,
	UpdateProjectMcpConnectionInput,
	SavePlatformOAuthAppInput,
	SettingsPageReadModel,
	SettingsRepository,
	UpsertWorkspaceSessionInput,
	WorkflowScheduler,
	WorkflowFileStore,
	CodeFunctionCatalogRepository,
	CodeCatalogFunctionRecord,
	CatalogFunctionSummary,
} from "$lib/server/application/ports";
import type { AgentConfig } from "$lib/types/agents";
import type { BenchmarkInstanceRow } from "$lib/types/benchmark-instance";
import type { SessionDetail, SessionStopReason, UserEvent } from "$lib/types/sessions";
import {
	applyWorkflowInputDefaults,
	getPromptExpansionConfig,
} from "$lib/utils/workflow-input-config";

const PROBLEM_PREVIEW_LEN = 240;
const DEV_SESSION_WORKFLOW_ID = "microservice-dev-session";
const TOOL_CAPABLE_BENCHMARK_PROVIDERS = new Set([
	"anthropic",
	"openai",
	"foundry",
	"together",
	"nvidia",
	"deepseek",
	"alibaba",
	"kimi",
	"googleai",
]);
const PINNED_ADMIN_PIECES = new Set(["github", "google-calendar", "openai"]);
const MCP_TOKEN_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const PROJECT_MEMBERSHIP_ROLES: readonly ProjectMembershipRole[] = [
	"ADMIN",
	"EDITOR",
	"OPERATOR",
	"VIEWER",
];
const BENCHMARK_INSTANCE_ANNOTATION_VERDICTS: BenchmarkInstanceAnnotationVerdict[] = [
	"correct",
	"incorrect",
	"partial",
	"unsure",
];

type BenchmarkInstanceEnvironmentStatus = BenchmarkInstanceRow["environmentStatus"];

function trimProblem(s: string | null): string {
	if (!s) return "";
	const cleaned = s.replace(/\s+/g, " ").trim();
	return cleaned.length > PROBLEM_PREVIEW_LEN
		? `${cleaned.slice(0, PROBLEM_PREVIEW_LEN).trimEnd()}...`
		: cleaned;
}

function metadataString(
	metadata: Record<string, unknown> | null | undefined,
	keys: string[],
): string | null {
	for (const key of keys) {
		const value = metadata?.[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number") return String(value);
	}
	return null;
}

function parseDurationMs(value: string | null): number | null {
	if (!value) return null;
	const durationMs = Number(value);
	return Number.isFinite(durationMs) ? durationMs : null;
}

function normalizePieceName(pieceName: string): string {
	return pieceName.startsWith("@activepieces/piece-")
		? pieceName.slice("@activepieces/piece-".length)
		: pieceName;
}

function normalizeMcpPieceName(value: string | null | undefined): string {
	return (value || "")
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, "")
		.replace(/[_\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function mcpPieceCandidates(value: string | null | undefined): string[] {
	const normalized = normalizeMcpPieceName(value);
	if (!normalized) return [];
	return [normalized, `@activepieces/piece-${normalized}`];
}

function pieceMcpRegistryRef(pieceName: string): string {
	return `ap-${normalizeMcpPieceName(pieceName)}-service`;
}

function pieceMcpServerUrl(pieceName: string): string {
	return `http://${pieceMcpRegistryRef(pieceName)}/mcp`;
}

function generateHostedMcpToken(length = 72): string {
	const bytes = randomBytes(length);
	return Array.from(
		bytes,
		(byte) => MCP_TOKEN_ALPHABET[byte % MCP_TOKEN_ALPHABET.length],
	).join("");
}

function parseBoolString(value: unknown, defaultValue: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.toLowerCase() === "true";
	return defaultValue;
}

function parseHostedMcpInputSchema(value: unknown): HostedMcpInputProperty[] {
	if (!value) return [];
	if (Array.isArray(value)) return value as HostedMcpInputProperty[];
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed) ? (parsed as HostedMcpInputProperty[]) : [];
		} catch {
			return [];
		}
	}
	return [];
}

function getHostedMcpTriggerFromWorkflowNodes(nodes: unknown): {
	enabled: boolean;
	toolName: string;
	toolDescription: string;
	inputSchema: HostedMcpInputProperty[];
	returnsResponse: boolean;
} | null {
	if (!Array.isArray(nodes)) return null;

	const triggerNode = nodes.find((node) => {
		if (!isRecord(node)) return false;
		const data = node.data;
		return isRecord(data) && data.type === "trigger";
	});
	if (!isRecord(triggerNode)) return null;
	const data = isRecord(triggerNode.data) ? triggerNode.data : null;
	const config = isRecord(data?.config) ? data.config : {};
	if (config.triggerType !== "MCP") return null;

	return {
		enabled: parseBoolString(config.enabled, true),
		toolName: typeof config.toolName === "string" ? config.toolName : "",
		toolDescription:
			typeof config.toolDescription === "string" ? config.toolDescription : "",
		inputSchema: parseHostedMcpInputSchema(config.inputSchema),
		returnsResponse: parseBoolString(config.returnsResponse, false),
	};
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
	if (!value) return null;
	const trimmed = value.trim();
	return trimmed ? trimTrailingSlash(trimmed) : null;
}

function resolvePublicMcpGatewayBaseUrl(requestUrl?: string | null): string | null {
	const explicit =
		normalizeBaseUrl(env.MCP_GATEWAY_BASE_URL) ?? normalizeBaseUrl(env.APP_URL);
	if (explicit) return explicit;
	if (!requestUrl) return null;
	try {
		return new URL(requestUrl).origin;
	} catch {
		return null;
	}
}

function isScopedExecutionInScope(
	execution: WorkflowExecutionRecord | null,
	input: { userId: string; projectId?: string | null },
): execution is WorkflowExecutionRecord {
	if (!execution) return false;
	if (execution.projectId && input.projectId) {
		return execution.projectId === input.projectId;
	}
	if (!execution.projectId) {
		return execution.userId === input.userId;
	}
	return execution.userId === input.userId;
}

function buildHostedMcpServerUrl(
	projectId: string,
	requestUrl?: string | null,
): string | null {
	const baseUrl = resolvePublicMcpGatewayBaseUrl(requestUrl);
	if (!baseUrl) return null;
	return `${baseUrl}/api/v1/projects/${encodeURIComponent(projectId)}/mcp-server/http`;
}

function canWriteHostedMcp(role: string | null | undefined): boolean {
	return role === "ADMIN" || role === "EDITOR";
}

function humanizeMcpPieceName(pieceName: string): string {
	return normalizeMcpPieceName(pieceName)
		.split("-")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function metadataFromMcpBody(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return { transport: "streamable_http", ...(value as Record<string, unknown>) };
	}
	return { transport: "streamable_http" };
}

function serverKeyFromDisplayName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function parseMcpToolSelection(
	value: unknown,
): { ok: true; value: { tools: string[] } | null } | { ok: false; message: string } {
	if (value === null) return { ok: true, value: null };
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return { ok: false, message: "toolSelection must be null or { tools: string[] }" };
	}
	const tools = (value as Record<string, unknown>).tools;
	if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string")) {
		return { ok: false, message: "toolSelection.tools must be an array of tool names" };
	}
	return {
		ok: true,
		value: {
			tools: Array.from(new Set(tools.map((tool) => tool.trim()).filter(Boolean))),
		},
	};
}

function isActivepiecesPieceServiceHost(hostname: string): boolean {
	const serviceName = hostname.split(".")[0] ?? "";
	return /^ap-[a-z0-9]([-a-z0-9]*[a-z0-9])?-service$/.test(serviceName);
}

function normalizePieceMcpServerUrl(value: string): string {
	const text = value.trim();
	if (!text) return text;
	try {
		const url = new URL(text);
		if (isActivepiecesPieceServiceHost(url.hostname)) {
			if (url.port === "3100") {
				url.port = "";
			}
			if (!url.hostname.includes(".")) {
				url.hostname = `${url.hostname}.workflow-builder.svc.cluster.local`;
			}
		}
		return url.toString();
	} catch {
		return text;
	}
}

function mcpToolNameFromUnknown(value: unknown): string | null {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || null;
	}
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["name", "toolName", "id", "title"]) {
			const candidate = record[key];
			if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
		}
	}
	return null;
}

function normalizeMcpToolNames(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const names = value
		.map(mcpToolNameFromUnknown)
		.filter((item): item is string => Boolean(item));
	return Array.from(new Set(names));
}

function mcpToolsFromMetadata(metadata: Record<string, unknown> | null): string[] {
	const candidates = [metadata?.toolNames, metadata?.tools, metadata?.allowedTools];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) return normalizeMcpToolNames(candidate);
	}
	return [];
}

function mcpHealthUrl(serverUrl: string): string {
	const url = new URL(serverUrl);
	url.pathname = url.pathname.replace(/\/mcp\/?$/, "/health");
	if (!url.pathname.endsWith("/health")) {
		url.pathname = `${url.pathname.replace(/\/+$/, "")}/health`;
	}
	url.search = "";
	return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeSessionStopReason(value: unknown): SessionStopReason | null {
	const stopReasonData = isRecord(value) ? value : null;
	if (!stopReasonData) return null;
	const t = String(stopReasonData.type ?? "end_turn");
	const normalizedType =
		t === "end_turn" ||
		t === "requires_action" ||
		t === "retries_exhausted" ||
		t === "interrupted" ||
		t === "terminated"
			? t
			: "end_turn";
	return {
		type: normalizedType,
		event_ids: Array.isArray(stopReasonData.event_ids)
			? stopReasonData.event_ids.filter(
					(v): v is string => typeof v === "string",
				)
			: undefined,
	};
}

function checkpointRemoteWarning(value: unknown): Record<string, unknown> | null {
	if (!isRecord(value)) return null;
	const remoteStatus = stringOrNull(value.remoteStatus);
	const remoteError = stringOrNull(value.remoteError);
	if (!remoteError) return null;
	if (remoteStatus !== "error" && remoteStatus !== "skipped") return null;
	return {
		remoteStatus,
		remoteError,
		remoteRef: stringOrNull(value.remoteRef),
		toolCallId: stringOrNull(value.toolCallId),
		toolName: stringOrNull(value.toolName),
	};
}

function isServerlessWorkflow10Spec(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const document = value.document;
	if (!isRecord(document)) return false;
	return (
		document.dsl === "1.0.0" &&
		typeof document.namespace === "string" &&
		typeof document.name === "string"
	);
}

function hostedMcpToolInput(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

function hostedMcpTraceHeaders(
	traceHeaders: Record<string, string> | undefined,
): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	for (const name of ["traceparent", "tracestate", "baggage"]) {
		const value = traceHeaders?.[name];
		if (value) headers[name] = value;
	}
	return headers;
}

function firstAuthRecord(auth: unknown): Record<string, unknown> | null {
	if (Array.isArray(auth)) {
		return auth.find(isRecord) ?? null;
	}
	return isRecord(auth) ? auth : null;
}

function mcpPieceAuthType(auth: unknown): string {
	const record = firstAuthRecord(auth);
	const type = typeof record?.type === "string" ? record.type.trim() : "";
	return type || "NONE";
}

function mcpPieceAuthDisplayName(auth: unknown): string | null {
	const record = firstAuthRecord(auth);
	const displayName =
		typeof record?.displayName === "string" ? record.displayName.trim() : "";
	return displayName || null;
}

function isOAuth2AuthType(authType: string | null | undefined): boolean {
	return String(authType || "").toUpperCase().includes("OAUTH2");
}

function mcpPieceRequiresAuth(authType: string | null | undefined): boolean {
	const normalized = String(authType || "").toUpperCase();
	return Boolean(normalized && normalized !== "NONE" && normalized !== "NO_AUTH");
}

function mcpActionCount(actions: unknown): number {
	if (!isRecord(actions)) return 0;
	return Object.keys(actions).length;
}

function canonicalMcpPieceName(pieceName: string): string {
	const normalized = normalizeMcpPieceName(pieceName);
	return normalized ? `@activepieces/piece-${normalized}` : pieceName;
}

function mcpCatalogSearchableText(entry: {
	pieceName: string;
	displayName: string;
	description: string | null;
	categories: string[];
	authType: string;
}): string {
	return [
		entry.pieceName,
		entry.displayName,
		entry.description ?? "",
		entry.authType,
		...entry.categories,
	]
		.join(" ")
		.toLowerCase();
}

function appConnectionPieceCandidates(value: string): string[] {
	const normalized = normalizeMcpPieceName(value);
	const raw = value.trim();
	const candidates = new Set([normalized, raw]);
	if (raw.startsWith("@activepieces/piece-")) {
		candidates.add(raw.slice("@activepieces/piece-".length));
	} else if (normalized) {
		candidates.add(`@activepieces/piece-${normalized}`);
	}
	return Array.from(candidates).filter(Boolean);
}

function appConnectionMatchesPieceFilter(
	connectionPieceName: string,
	filter: string,
	piece?: { name: string; displayName: string; categories: string[] },
): boolean {
	const normalizedFilter = filter.trim().toLowerCase();
	if (!normalizedFilter) return true;

	const candidates = appConnectionPieceCandidates(connectionPieceName).map((item) =>
		item.toLowerCase(),
	);
	if (
		candidates.some(
			(candidate) =>
				candidate === normalizedFilter || candidate.includes(normalizedFilter),
		)
	) {
		return true;
	}

	if (piece) {
		const providerCandidates = [
			piece.name,
			piece.displayName,
			...piece.categories,
		]
			.map((item) => item.toLowerCase())
			.filter(Boolean);
		return providerCandidates.some(
			(candidate) =>
				candidate === normalizedFilter || candidate.includes(normalizedFilter),
		);
	}

	return false;
}

const REFRESH_THRESHOLD_SECONDS = 5 * 60;

function isEncryptedObject(value: unknown): value is EncryptedObject {
	return (
		!!value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"iv" in value &&
		"data" in value
	);
}

function resolveAppConnectionClientSecret(value: unknown): string {
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (isEncryptedObject(parsed)) return decryptString(parsed);
		} catch {
			return value;
		}
		return value;
	}
	if (isEncryptedObject(value)) return decryptString(value);
	throw new Error("OAuth client secret is not configured correctly");
}

function isTokenExpired(token: Record<string, unknown>): boolean {
	const claimedAt = typeof token.claimed_at === "number" ? token.claimed_at : 0;
	const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 3600;
	if (!claimedAt) return false;
	const now = Math.floor(Date.now() / 1000);
	return now + REFRESH_THRESHOLD_SECONDS >= claimedAt + expiresIn;
}

function formatPieceName(pieceName: string): string {
	return normalizePieceName(pieceName)
		.split("-")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function hasAdminPieceName(piece: {
	name: string | null;
	displayName: string | null;
	logoUrl: string | null;
}): piece is { name: string; displayName: string | null; logoUrl: string | null } {
	return typeof piece.name === "string" && piece.name.length > 0;
}

function classifyEnvironmentBuild(
	build: BenchmarkBrowserEnvironmentBuildRecord,
): BenchmarkInstanceEnvironmentStatus {
	if (
		build.status === "validated" &&
		build.validationStatus === "validated" &&
		build.sandboxImage &&
		build.digest
	) {
		return "validated";
	}
	if (build.status === "queued" || build.status === "building") {
		return "building";
	}
	return "failed";
}

const ENVIRONMENT_STATUS_RANK: Record<BenchmarkInstanceEnvironmentStatus, number> = {
	validated: 4,
	building: 3,
	failed: 2,
	not_built: 1,
};

function createPlaintextWorkflowBuilderApiKey() {
	const plaintextKey = `wfb_${randomBytes(32).toString("hex")}`;
	return {
		plaintextKey,
		keyPrefix: `${plaintextKey.slice(0, 11)}...`,
		keyHash: createHash("sha256").update(plaintextKey).digest("hex"),
	};
}

function isProjectMembershipRole(value: unknown): value is ProjectMembershipRole {
	return (
		typeof value === "string" &&
		(PROJECT_MEMBERSHIP_ROLES as readonly string[]).includes(value)
	);
}

function parseDateOrDefault(value: string | null | undefined, fallback: Date): Date {
	if (!value) return fallback;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function usageMonthStart(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

function toCodeCatalogFunction(record: CodeCatalogFunctionRecord) {
	return {
		name: record.slug,
		version: record.latestPublishedVersion || record.version,
		displayName: record.name,
		description: record.description || "",
		pieceName: "code-functions",
		actionName: record.entrypoint,
		sourceKind: "code" as const,
		codeFunctionId: record.id,
		language: record.language,
	};
}

function workspaceSlugify(name: string): string {
	return (
		name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) + "-" + generateId().slice(0, 8)
	);
}

function workspaceSummaryFromRecord(
	record: WorkspaceProjectMembershipRecord,
	currentProjectId: string | null,
): WorkspaceSummary {
	return {
		id: record.id,
		displayName: record.displayName,
		externalId: record.externalId,
		slug: record.id === currentProjectId ? "default" : record.externalId,
		role: record.role,
		isCurrent: record.id === currentProjectId,
		createdAt: record.createdAt.toISOString(),
	};
}

export class ApplicationWorkflowDataService implements WorkflowDataService {
	constructor(
		private readonly deps: {
			workflowDefinitions: WorkflowDefinitionRepository;
			workflowTriggers: WorkflowTriggerStore;
			userProfiles: UserProfileRepository;
			settings: SettingsRepository;
			mcpConnections: McpConnectionRepository;
			hostedMcpServers: HostedMcpServerRepository;
			mcpRuns: McpRunRepository;
			appConnections: AppConnectionRepository;
			adminPieces: AdminPieceRepository;
			apiKeys: ApiKeyStore;
			workspaceProjects: WorkspaceProjectRepository;
			pieceCatalog: PieceCatalogRepository;
			pieceExecutions?: PieceExecutionRepository;
			browserArtifacts?: WorkflowBrowserArtifactStore;
			codeFunctionCatalog?: CodeFunctionCatalogRepository;
			benchmarkArtifactMetadata?: BenchmarkArtifactMetadataRepository;
			benchmarkEvaluationResults?: BenchmarkEvaluationResultRepository;
			benchmarkRunLifecycle?: BenchmarkRunLifecyclePort;
			benchmarkEvaluationTelemetry?: BenchmarkEvaluationTelemetryPort;
			benchmarkEvaluationEvents?: BenchmarkEvaluationEventNotifier;
			benchmarkBrowser: BenchmarkBrowserRepository;
			benchmarkDatasetPromotions?: BenchmarkDatasetPromotionRepository;
			benchmarkInstanceDetails?: BenchmarkInstanceDetailReadRepository;
			benchmarkRunInstanceDetails?: BenchmarkRunInstanceDetailReadRepository;
			benchmarkRunInstanceAnnotations?: BenchmarkRunInstanceAnnotationRepository;
			benchmarkRunInstanceProgress?: BenchmarkRunInstanceProgressReadRepository;
			benchmarkRunInstanceScores?: BenchmarkRunInstanceScoreReadRepository;
			benchmarkRunReads?: BenchmarkRunReadRepository;
			devEnvironments?: DevEnvironmentReadRepository;
			benchmarkRuns?: BenchmarkRunRepository;
			activityRateTargets?: WorkflowActivityRateTargetRepository;
			observabilityTraces?: ObservabilityTraceRepository;
			workflowMonitorReads?: WorkflowMonitorReadRepository;
			resourceUsages?: ResourceUsageReadRepository;
			aiAssistantMessages?: WorkflowAiAssistantMessageRepository;
			securityAudit?: SecurityAuditReadRepository;
			dashboard?: DashboardReadRepository;
			homePageReads?: HomePageReadRepository;
			modelCatalog?: ModelCatalogRepository;
			workflowExecutions: WorkflowExecutionRepository;
			sessions?: SessionRepository;
			sessionProvisioning?: SessionProvisioningReader;
			sessionEvents?: SessionEventLog;
			sessionRuntimeConfigs?: SessionRuntimeConfigReader;
			sessionRuntimeEvents?: SessionRuntimeEventRaiser;
			sessionAgentConfigCommands?: SessionAgentConfigCommandPort;
			codeCheckpoints?: WorkflowCodeCheckpointStore;
			evaluationArtifacts?: EvaluationArtifactStore;
			sessionTraceLifecycle?: SessionTraceLifecycleStore;
			peerAgentResolver?: PeerAgentResolver;
			workflowAgentReads?: WorkflowAgentReadRepository;
			runtimeRegistry?: RuntimeRegistryReader;
			sessionExperimentAgents?: SessionExperimentAgentStore;
			goalFlow?: GoalFlowReadStore;
			sessionEventNotifications: WorkflowSessionEventNotificationSource;
			artifactStore: ArtifactStore;
			workflowFiles?: WorkflowFileStore;
			workspaceSessions: WorkspaceSessionStore;
			agentRuns: WorkflowAgentRunStore;
			planArtifacts: WorkflowPlanArtifactStore;
			traceLineage: TraceLineageStore;
			usageReporting?: UsageReportingRepository;
			sandboxInventory?: SandboxInventoryRepository;
			sandboxRuntimeInventory?: SandboxRuntimeInventory;
			sessionRuntimeStatus?: SessionRuntimeStatusReader;
			workflowScheduler?: WorkflowScheduler;
		},
	) {}

	private requireWorkflowFiles(): WorkflowFileStore {
		if (!this.deps.workflowFiles) {
			throw new Error("Workflow file store not configured");
		}
		return this.deps.workflowFiles;
	}

	private requireSessions(): SessionRepository {
		if (!this.deps.sessions) {
			throw new Error("Session repository not configured");
		}
		return this.deps.sessions;
	}

	private async getScopedSession(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionDetail | null> {
		const sessions = this.requireSessions();
		const owner = await sessions.getSessionFileOwner(input.sessionId);
		if (!owner) return null;
		if (input.projectId && owner.projectId !== input.projectId) return null;
		if (!input.projectId && input.userId && owner.userId !== input.userId) {
			return null;
		}
		return sessions.getSession(input.sessionId);
	}

	private requireBenchmarkRuns(): BenchmarkRunRepository {
		if (!this.deps.benchmarkRuns) {
			throw new Error("Benchmark run repository not configured");
		}
		return this.deps.benchmarkRuns;
	}

	private requireBenchmarkRunReads(): BenchmarkRunReadRepository {
		if (!this.deps.benchmarkRunReads) {
			throw new Error("Benchmark run read repository not configured");
		}
		return this.deps.benchmarkRunReads;
	}

	private requireBenchmarkArtifactMetadata(): BenchmarkArtifactMetadataRepository {
		if (!this.deps.benchmarkArtifactMetadata) {
			throw new Error("Benchmark artifact metadata repository not configured");
		}
		return this.deps.benchmarkArtifactMetadata;
	}

	private requireBenchmarkEvaluationResults(): BenchmarkEvaluationResultRepository {
		if (!this.deps.benchmarkEvaluationResults) {
			throw new Error("Benchmark evaluation result repository not configured");
		}
		return this.deps.benchmarkEvaluationResults;
	}

	private requireBenchmarkRunLifecycle(): BenchmarkRunLifecyclePort {
		if (!this.deps.benchmarkRunLifecycle) {
			throw new Error("Benchmark run lifecycle port not configured");
		}
		return this.deps.benchmarkRunLifecycle;
	}

	private requireBenchmarkEvaluationTelemetry(): BenchmarkEvaluationTelemetryPort {
		if (!this.deps.benchmarkEvaluationTelemetry) {
			throw new Error("Benchmark evaluation telemetry port not configured");
		}
		return this.deps.benchmarkEvaluationTelemetry;
	}

	private requireBenchmarkEvaluationEvents(): BenchmarkEvaluationEventNotifier {
		if (!this.deps.benchmarkEvaluationEvents) {
			throw new Error("Benchmark evaluation event notifier not configured");
		}
		return this.deps.benchmarkEvaluationEvents;
	}

	private requireBenchmarkInstanceDetails(): BenchmarkInstanceDetailReadRepository {
		if (!this.deps.benchmarkInstanceDetails) {
			throw new Error("Benchmark instance detail read repository not configured");
		}
		return this.deps.benchmarkInstanceDetails;
	}

	private requireBenchmarkRunInstanceScores(): BenchmarkRunInstanceScoreReadRepository {
		if (!this.deps.benchmarkRunInstanceScores) {
			throw new Error("Benchmark run instance score read repository not configured");
		}
		return this.deps.benchmarkRunInstanceScores;
	}

	private requireBenchmarkRunInstanceDetails(): BenchmarkRunInstanceDetailReadRepository {
		if (!this.deps.benchmarkRunInstanceDetails) {
			throw new Error("Benchmark run instance detail read repository not configured");
		}
		return this.deps.benchmarkRunInstanceDetails;
	}

	private requireBenchmarkRunInstanceAnnotations(): BenchmarkRunInstanceAnnotationRepository {
		if (!this.deps.benchmarkRunInstanceAnnotations) {
			throw new Error("Benchmark run instance annotation repository not configured");
		}
		return this.deps.benchmarkRunInstanceAnnotations;
	}

	private requireBenchmarkRunInstanceProgress(): BenchmarkRunInstanceProgressReadRepository {
		if (!this.deps.benchmarkRunInstanceProgress) {
			throw new Error("Benchmark run instance progress repository not configured");
		}
		return this.deps.benchmarkRunInstanceProgress;
	}

	private requireBenchmarkDatasetPromotions(): BenchmarkDatasetPromotionRepository {
		if (!this.deps.benchmarkDatasetPromotions) {
			throw new Error("Benchmark dataset promotion repository not configured");
		}
		return this.deps.benchmarkDatasetPromotions;
	}

	private isResourceVisibleToCaller<T extends { userId: string; projectId: string | null }>(
		resource: T | null | undefined,
		caller: { userId: string; projectId?: string | null },
	): resource is T {
		if (!resource) return false;
		if (resource.projectId && caller.projectId) {
			return resource.projectId === caller.projectId;
		}
		return resource.userId === caller.userId;
	}

	private requireSessionEvents(): SessionEventLog {
		if (!this.deps.sessionEvents) {
			throw new Error("Session event log not configured");
		}
		return this.deps.sessionEvents;
	}

	private requireGoalFlow(): GoalFlowReadStore {
		if (!this.deps.goalFlow) {
			throw new Error("Goal flow read store not configured");
		}
		return this.deps.goalFlow;
	}

	private requireDevEnvironments(): DevEnvironmentReadRepository {
		if (!this.deps.devEnvironments) {
			throw new Error("Dev environment read repository not configured");
		}
		return this.deps.devEnvironments;
	}

	private requireActivityRateTargets(): WorkflowActivityRateTargetRepository {
		if (!this.deps.activityRateTargets) {
			throw new Error("Workflow activity-rate target repository not configured");
		}
		return this.deps.activityRateTargets;
	}

	private requireObservabilityTraces(): ObservabilityTraceRepository {
		if (!this.deps.observabilityTraces) {
			throw new Error("Observability trace repository not configured");
		}
		return this.deps.observabilityTraces;
	}

	private requireWorkflowMonitorReads(): WorkflowMonitorReadRepository {
		if (!this.deps.workflowMonitorReads) {
			throw new Error("Workflow monitor read repository not configured");
		}
		return this.deps.workflowMonitorReads;
	}

	private requireResourceUsages(): ResourceUsageReadRepository {
		if (!this.deps.resourceUsages) {
			throw new Error("Resource usage read repository not configured");
		}
		return this.deps.resourceUsages;
	}

	private requireAiAssistantMessages(): WorkflowAiAssistantMessageRepository {
		if (!this.deps.aiAssistantMessages) {
			throw new Error("AI assistant message repository not configured");
		}
		return this.deps.aiAssistantMessages;
	}

	private requireSecurityAudit(): SecurityAuditReadRepository {
		if (!this.deps.securityAudit) {
			throw new Error("Security audit read repository not configured");
		}
		return this.deps.securityAudit;
	}

	private requireDashboard(): DashboardReadRepository {
		if (!this.deps.dashboard) {
			throw new Error("Dashboard read repository not configured");
		}
		return this.deps.dashboard;
	}

	private requireHomePageReads(): HomePageReadRepository {
		if (!this.deps.homePageReads) {
			throw new Error("Home page read repository not configured");
		}
		return this.deps.homePageReads;
	}

	private requireSessionRuntimeConfigs(): SessionRuntimeConfigReader {
		if (!this.deps.sessionRuntimeConfigs) {
			throw new Error("Session runtime config reader not configured");
		}
		return this.deps.sessionRuntimeConfigs;
	}

	private requireSessionRuntimeStatus(): SessionRuntimeStatusReader {
		if (!this.deps.sessionRuntimeStatus) {
			throw new Error("Session runtime status reader not configured");
		}
		return this.deps.sessionRuntimeStatus;
	}

	private requireSessionRuntimeEvents(): SessionRuntimeEventRaiser {
		if (!this.deps.sessionRuntimeEvents) {
			throw new Error("Session runtime event raiser not configured");
		}
		return this.deps.sessionRuntimeEvents;
	}

	private requireSessionAgentConfigCommands(): SessionAgentConfigCommandPort {
		if (!this.deps.sessionAgentConfigCommands) {
			throw new Error("Session agent config command port not configured");
		}
		return this.deps.sessionAgentConfigCommands;
	}

	private requireSessionProvisioning(): SessionProvisioningReader {
		if (!this.deps.sessionProvisioning) {
			throw new Error("Session provisioning reader not configured");
		}
		return this.deps.sessionProvisioning;
	}

	private requireCodeCheckpoints(): WorkflowCodeCheckpointStore {
		if (!this.deps.codeCheckpoints) {
			throw new Error("Workflow code checkpoint store not configured");
		}
		return this.deps.codeCheckpoints;
	}

	private requireEvaluationArtifacts(): EvaluationArtifactStore {
		if (!this.deps.evaluationArtifacts) {
			throw new Error("Evaluation artifact store not configured");
		}
		return this.deps.evaluationArtifacts;
	}

	private requirePeerAgentResolver(): PeerAgentResolver {
		if (!this.deps.peerAgentResolver) {
			throw new Error("Peer agent resolver not configured");
		}
		return this.deps.peerAgentResolver;
	}

	private requireWorkflowAgentReads(): WorkflowAgentReadRepository {
		if (!this.deps.workflowAgentReads) {
			throw new Error("Workflow agent read repository not configured");
		}
		return this.deps.workflowAgentReads;
	}

	private requireRuntimeRegistry(): RuntimeRegistryReader {
		if (!this.deps.runtimeRegistry) {
			throw new Error("Runtime registry reader not configured");
		}
		return this.deps.runtimeRegistry;
	}

	private requireSessionExperimentAgents(): SessionExperimentAgentStore {
		if (!this.deps.sessionExperimentAgents) {
			throw new Error("Session experiment agent store not configured");
		}
		return this.deps.sessionExperimentAgents;
	}

	getUserProfile(userId: string) {
		return this.deps.userProfiles.getUserProfile(userId);
	}

	async getHomePageReadModel(input: {
		userId: string;
		projectId?: string | null;
		limit?: number;
	}): Promise<HomePageReadModel> {
		const homePageReads = this.requireHomePageReads();
		const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
		const projectId = input.projectId ?? null;
		const [profile, recentSessions, recentRuns] = await Promise.all([
			this.deps.userProfiles.getUserProfile(input.userId).catch(() => null),
			homePageReads
				.listRecentHomeSessions({
					userId: input.userId,
					projectId,
					limit,
				})
				.catch(() => []),
			projectId
				? homePageReads
						.listRecentHomeRuns({
							projectId,
							limit,
						})
						.catch(() => [])
				: Promise.resolve([]),
		]);

		return {
			user: profile
				? {
						name: profile.name ?? null,
						email: profile.email ?? null,
					}
				: null,
			recentSessions: recentSessions.map((session) => ({
				id: session.id,
				title: session.title ?? null,
				status: session.status,
				agentId: session.agentId,
				updatedAt: session.updatedAt.toISOString(),
			})),
			recentRuns: recentRuns.map((run) => ({
				executionId: run.executionId,
				workflowId: run.workflowId,
				workflowName: run.workflowName,
				status: run.status,
				startedAt: run.startedAt.toISOString(),
				durationMs: parseDurationMs(run.duration),
			})),
		};
	}

	async isPlatformAdmin(userId: string) {
		const profile = await this.deps.userProfiles.getUserProfile(userId);
		return profile?.platformRole === "ADMIN";
	}

	async canViewContaminationRiskMetadata(input: {
		userId: string;
		projectId?: string | null;
	}) {
		const profile = await this.deps.userProfiles.getUserProfile(input.userId);
		if (profile?.platformRole === "ADMIN") return true;
		if (!input.projectId) return false;
		const role = await this.deps.workspaceProjects.getProjectMemberRole({
			projectId: input.projectId,
			userId: input.userId,
		});
		return role === "ADMIN" || role === "OPERATOR";
	}

	async getSettingsPageReadModel(input: {
		userId: string;
		sessionPlatformId?: string | null;
	}): Promise<SettingsPageReadModel> {
		const profile = await this.deps.settings.getSettingsUserProfile(input.userId);
		const platformId = profile?.platformId ?? input.sessionPlatformId ?? null;
		const [oauthApps, oauthPieces] = await Promise.all([
			platformId
				? this.deps.settings.listPlatformOAuthApps(platformId)
				: Promise.resolve([]),
			this.deps.settings.listOAuthPieces(),
		]);

		const configuredByPiece = new Map(
			oauthApps.map((app) => [normalizePieceName(app.pieceName), app]),
		);
		const oauthPieceNames = new Set(oauthPieces.map((piece) => piece.name));
		const enrichedOauthApps = [
			...oauthPieces.map((piece) => {
				const app = configuredByPiece.get(piece.name);
				return {
					id: app?.id ?? null,
					pieceName: `@activepieces/piece-${piece.name}`,
					clientId: app?.clientId ?? "",
					displayName: piece.displayName || formatPieceName(piece.name),
					logoUrl: piece.logoUrl || null,
					configured: Boolean(app),
					createdAt: app?.createdAt ?? null,
					updatedAt: app?.updatedAt ?? null,
				};
			}),
			...oauthApps
				.filter((app) => !oauthPieceNames.has(normalizePieceName(app.pieceName)))
				.map((app) => ({
					id: app.id,
					pieceName: app.pieceName,
					clientId: app.clientId,
					displayName: formatPieceName(app.pieceName),
					logoUrl: null,
					configured: true,
					createdAt: app.createdAt,
					updatedAt: app.updatedAt,
				})),
		].sort((a, b) => a.displayName.localeCompare(b.displayName));

		return {
			profile,
			oauthApps: enrichedOauthApps,
		};
	}

	async savePlatformOAuthApp(input: SavePlatformOAuthAppInput) {
		const id = input.id?.trim() || null;
		const clientSecret = input.clientSecret?.trim();
		const encryptedClientSecret = clientSecret ? encryptString(clientSecret) : null;
		if (id) {
			await this.deps.settings.savePlatformOAuthApp({
				id,
				pieceName: input.pieceName.trim(),
				clientId: input.clientId.trim(),
				encryptedClientSecret,
			});
			return { success: true as const };
		}

		const platformId = await this.deps.settings.resolvePlatformId(
			input.sessionPlatformId,
		);
		const app = await this.deps.settings.savePlatformOAuthApp({
			id: generateId(),
			platformId,
			pieceName: input.pieceName.trim(),
			clientId: input.clientId.trim(),
			encryptedClientSecret,
		});
		return { success: true as const, app };
	}

	async deletePlatformOAuthApp(id: string) {
		await this.deps.settings.deletePlatformOAuthApp(id);
	}

	listProjectMcpConnections(projectId: string) {
		return this.deps.mcpConnections.listProjectConnections(projectId);
	}

	private async validateMcpCredentialBinding(input: {
		projectId: string;
		pieceName: string | null | undefined;
		externalId: unknown;
	}): Promise<{ ok: true; externalId: string | null } | { ok: false; message: string }> {
		const externalId = typeof input.externalId === "string" ? input.externalId.trim() : "";
		if (!externalId) return { ok: true, externalId: null };
		const pieceNameCandidates = mcpPieceCandidates(input.pieceName);
		if (pieceNameCandidates.length === 0) {
			return {
				ok: false,
				message: "connectionExternalId can only be set for a piece MCP connection",
			};
		}
		const exists = await this.deps.mcpConnections.activeAppConnectionExistsForPiece({
			projectId: input.projectId,
			externalId,
			pieceNameCandidates,
		});
		if (!exists) {
			return {
				ok: false,
				message:
					"connectionExternalId must reference an active app connection for the same piece",
			};
		}
		return { ok: true, externalId };
	}

	async createProjectMcpConnection(input: CreateProjectMcpConnectionInput) {
		const sourceType =
			typeof input.sourceType === "string" ? input.sourceType : "custom_url";
		if (sourceType !== "custom_url" && sourceType !== "nimble_piece") {
			return {
				ok: false as const,
				status: 400 as const,
				message: "sourceType must be custom_url or nimble_piece",
			};
		}

		if (sourceType === "nimble_piece") {
			const pieceName = normalizeMcpPieceName(
				typeof input.pieceName === "string" ? input.pieceName : "",
			);
			if (!pieceName) {
				return {
					ok: false as const,
					status: 400 as const,
					message: "pieceName is required for piece MCP connections",
				};
			}

			const displayName =
				(typeof input.displayName === "string" && input.displayName.trim()) ||
				humanizeMcpPieceName(pieceName);
			const binding = await this.validateMcpCredentialBinding({
				projectId: input.projectId,
				pieceName,
				externalId: input.connectionExternalId,
			});
			if (!binding.ok) {
				return { ok: false as const, status: 400 as const, message: binding.message };
			}
			const metadata = metadataFromMcpBody(input.metadata);
			const existing = await this.deps.mcpConnections.findProjectNimblePieceConnection({
				projectId: input.projectId,
				pieceName,
			});

			if (existing) {
				const connection = await this.deps.mcpConnections.updateProjectConnection({
					id: existing.id,
					projectId: input.projectId,
					connectionExternalId: binding.externalId,
					displayName,
					registryRef: pieceMcpRegistryRef(pieceName),
					serverUrl: pieceMcpServerUrl(pieceName),
					status: "ENABLED",
					metadata,
					updatedBy: input.userId,
				});
				if (!connection) {
					return {
						ok: false as const,
						status: 404 as const,
						message: "Connection not found",
					};
				}
				return { ok: true as const, status: 200 as const, connection };
			}

			const connection = await this.deps.mcpConnections.createProjectConnection({
				id: generateId(),
				projectId: input.projectId,
				sourceType: "nimble_piece",
				pieceName,
				serverKey: null,
				connectionExternalId: binding.externalId,
				displayName,
				registryRef: pieceMcpRegistryRef(pieceName),
				serverUrl: pieceMcpServerUrl(pieceName),
				status: "ENABLED",
				metadata,
				createdBy: input.userId,
				updatedBy: input.userId,
			});
			return { ok: true as const, status: 201 as const, connection };
		}

		const displayName =
			typeof input.displayName === "string" ? input.displayName.trim() : "";
		const serverUrl = typeof input.serverUrl === "string" ? input.serverUrl.trim() : "";
		if (!displayName || !serverUrl) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "displayName and serverUrl are required",
			};
		}
		if (!serverUrl.startsWith("http://") && !serverUrl.startsWith("https://")) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "serverUrl must be HTTP(S)",
			};
		}

		const connection = await this.deps.mcpConnections.createProjectConnection({
			id: generateId(),
			projectId: input.projectId,
			sourceType: "custom_url",
			pieceName: null,
			serverKey: serverKeyFromDisplayName(displayName),
			connectionExternalId: null,
			displayName,
			registryRef: null,
			serverUrl,
			status: "ENABLED",
			metadata: metadataFromMcpBody(input.metadata),
			createdBy: input.userId,
			updatedBy: input.userId,
		});
		return { ok: true as const, status: 201 as const, connection };
	}

	async updateProjectMcpConnection(input: UpdateProjectMcpConnectionInput) {
		if (
			input.status !== undefined &&
			input.status !== "ENABLED" &&
			input.status !== "DISABLED"
		) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "status must be ENABLED or DISABLED",
			};
		}

		const existing = await this.deps.mcpConnections.findProjectConnection({
			id: input.id,
			projectId: input.projectId,
		});
		if (!existing) {
			return { ok: false as const, status: 404 as const, message: "Connection not found" };
		}

		const updates: Parameters<
			McpConnectionRepository["updateProjectConnection"]
		>[0] = {
			id: input.id,
			projectId: input.projectId,
			updatedBy: input.userId,
		};
		if (input.status !== undefined) updates.status = input.status;

		if (input.connectionExternalIdProvided) {
			if (existing.sourceType !== "nimble_piece") {
				return {
					ok: false as const,
					status: 400 as const,
					message: "connectionExternalId can only be set for piece MCP connections",
				};
			}
			const binding = await this.validateMcpCredentialBinding({
				projectId: input.projectId,
				pieceName: existing.pieceName,
				externalId: input.connectionExternalId,
			});
			if (!binding.ok) {
				return { ok: false as const, status: 400 as const, message: binding.message };
			}
			updates.connectionExternalId = binding.externalId;
		}

		if (input.toolSelectionProvided) {
			if (existing.sourceType !== "nimble_piece") {
				return {
					ok: false as const,
					status: 400 as const,
					message: "toolSelection can only be set for piece MCP connections",
				};
			}
			const parsed = parseMcpToolSelection(input.toolSelection);
			if (!parsed.ok) {
				return { ok: false as const, status: 400 as const, message: parsed.message };
			}
			const metadata = { ...(existing.metadata ?? {}) };
			if (parsed.value === null) {
				delete metadata.toolSelection;
			} else {
				metadata.toolSelection = parsed.value;
			}
			updates.metadata = Object.keys(metadata).length > 0 ? metadata : null;
		}

		const connection = await this.deps.mcpConnections.updateProjectConnection(updates);
		if (!connection) {
			return { ok: false as const, status: 404 as const, message: "Connection not found" };
		}
		return { ok: true as const, status: 200 as const, connection };
	}

	async deleteProjectMcpConnection(input: { id: string; projectId: string }) {
		const existing = await this.deps.mcpConnections.findProjectConnection(input);
		if (!existing) {
			return { ok: false as const, status: 404 as const, message: "Connection not found" };
		}
		if (existing.sourceType === "hosted_workflow") {
			return {
				ok: false as const,
				status: 400 as const,
				message: "Cannot delete hosted workflow connections",
			};
		}
		await this.deps.mcpConnections.deleteProjectConnection(input);
		return { ok: true as const };
	}

	async discoverProjectMcpConnectionTools(input: { id: string; projectId: string }) {
		const connection = await this.deps.mcpConnections.findProjectConnection(input);
		if (!connection) {
			return {
				ok: false as const,
				status: 404 as const,
				message: "MCP connection not found",
			};
		}

		const metadataTools = mcpToolsFromMetadata(connection.metadata);
		if (metadataTools.length > 0) {
			return { ok: true as const, toolNames: metadataTools, source: "metadata" as const };
		}

		if (!connection.serverUrl) {
			return { ok: true as const, toolNames: [], source: "none" as const };
		}

		try {
			const response = await fetch(
				mcpHealthUrl(normalizePieceMcpServerUrl(connection.serverUrl)),
				{
					headers: { Accept: "application/json" },
					signal: AbortSignal.timeout(5000),
				},
			);
			if (!response.ok) {
				return {
					ok: false as const,
					status: response.status as 500 | 502,
					message: `MCP server health check failed with HTTP ${response.status}`,
				};
			}
			const payload = (await response.json()) as Record<string, unknown>;
			const toolNames = normalizeMcpToolNames(payload.toolNames ?? payload.tools);
			return { ok: true as const, toolNames, source: "health" as const };
		} catch (err) {
			return {
				ok: false as const,
				status: 502 as const,
				message: `Unable to discover MCP tools: ${err instanceof Error ? err.message : "Unknown error"}`,
			};
		}
	}

	async getMcpCatalogPieceActions(pieceNameInput: string) {
		const pieceName = normalizeMcpPieceName(pieceNameInput);
		if (!pieceName) {
			return { ok: false as const, status: 404 as const, message: "Integration not found" };
		}
		const piece = await this.deps.pieceCatalog.getLatestPieceMetadata(
			mcpPieceCandidates(pieceName),
		);
		if (!piece) {
			return { ok: false as const, status: 404 as const, message: "Integration not found" };
		}

		return {
			ok: true as const,
			pieceName,
			actions: pieceActionsFromMetadata(piece.actions),
		};
	}

	async getMcpConnectionCatalog(input: {
		projectId: string;
		platformId?: string | null;
		query?: string | null;
		authOnly?: boolean;
		configuredOnly?: boolean;
	}) {
		const q = (input.query ?? "").trim().toLowerCase();
		const [pieces, appConnectionRows, projectConnections] = await Promise.all([
			this.deps.pieceCatalog.listMcpCatalogPieces(),
			this.deps.mcpConnections.listActiveAppConnectionCatalogSummaries(input.projectId),
			this.deps.mcpConnections.listProjectConnections(input.projectId),
		]);

		const pieceNames = Array.from(
			new Set(
				pieces.flatMap((piece) => {
					const normalized = normalizeMcpPieceName(piece.name);
					return [normalized, canonicalMcpPieceName(piece.name)].filter(Boolean);
				}),
			),
		);
		const oauthConfigured = new Set(
			(
				await this.deps.mcpConnections.listPlatformOAuthAppPieceNames({
					pieceNames,
					platformId: input.platformId,
				})
			).map((pieceName) => normalizeMcpPieceName(pieceName)),
		);

		const appConnectionsByPiece = new Map<
			string,
			{
				id: string;
				externalId: string;
				displayName: string;
				type: string;
				status: string;
			}[]
		>();
		for (const row of appConnectionRows) {
			const key = normalizeMcpPieceName(row.pieceName);
			if (!key) continue;
			const list = appConnectionsByPiece.get(key) ?? [];
			const { pieceName: _pieceName, ...summary } = row;
			list.push(summary);
			appConnectionsByPiece.set(key, list);
		}

		const mcpByPiece = new Map<
			string,
			{
				id: string;
				displayName: string;
				sourceType: "nimble_piece";
				pieceName: string | null;
				serverKey: string | null;
				connectionExternalId: string | null;
				serverUrl: string | null;
				status: string;
				metadata: Record<string, unknown> | null;
			}
		>();
		for (const row of projectConnections) {
			if (row.sourceType !== "nimble_piece") continue;
			const key = normalizeMcpPieceName(row.pieceName);
			if (!key) continue;
			mcpByPiece.set(key, {
				id: row.id,
				displayName: row.displayName,
				sourceType: row.sourceType,
				pieceName: row.pieceName,
				serverKey: row.serverKey,
				connectionExternalId: row.connectionExternalId,
				serverUrl: row.serverUrl,
				status: row.status,
				metadata: row.metadata,
			});
		}

		const entries = pieces
			.map((piece) => {
				const normalized = normalizeMcpPieceName(piece.name);
				if (!normalized) return null;
				const actionTotal = mcpActionCount(piece.actions);
				if (actionTotal <= 0) return null;
				const authType = mcpPieceAuthType(piece.auth);
				const entry = {
					pieceName: normalized,
					canonicalPieceName: `@activepieces/piece-${normalized}`,
					displayName: piece.displayName?.trim() || humanizeMcpPieceName(normalized),
					description: piece.description ?? null,
					logoUrl: piece.logoUrl || null,
					categories: Array.isArray(piece.categories) ? piece.categories : [],
					authType,
					authDisplayName: mcpPieceAuthDisplayName(piece.auth),
					requiresAuth: mcpPieceRequiresAuth(authType),
					isOAuth2: isOAuth2AuthType(authType),
					oauthAppConfigured: oauthConfigured.has(normalized),
					actionCount: actionTotal,
					registryRef: pieceMcpRegistryRef(normalized),
					serverUrl: pieceMcpServerUrl(normalized),
					appConnections: appConnectionsByPiece.get(normalized) ?? [],
					mcpConnection: mcpByPiece.get(normalized) ?? null,
					availableOnly: piece.availableOnly === true,
				};
				return entry;
			})
			.filter((entry) => entry !== null)
			.filter((entry) => !input.authOnly || entry.requiresAuth)
			.filter((entry) => !input.configuredOnly || Boolean(entry.mcpConnection))
			.filter((entry) => !q || mcpCatalogSearchableText(entry).includes(q))
			.sort((a, b) => a.displayName.localeCompare(b.displayName));

		return { entries };
	}

	async getMcpAvailability(input: {
		projectId: string;
		platformId?: string | null;
	}): Promise<McpAvailabilityReadModel> {
		const [
			{ entries: registeredEntries, path: catalogPath },
			pieces,
			appConnections,
			projectConnectionRows,
		] = await Promise.all([
			loadRegisteredPieceMcpCatalog(),
			this.deps.pieceCatalog.listMcpCatalogPieces(),
			this.deps.mcpConnections.listActiveAppConnectionCatalogSummaries(input.projectId),
			this.deps.mcpConnections.listProjectConnections(input.projectId),
		]);

		const projectConnections: McpCatalogConfiguredConnectionSummary[] =
			projectConnectionRows.map((row) => ({
				id: row.id,
				displayName: row.displayName,
				sourceType: row.sourceType,
				pieceName: row.pieceName,
				serverKey: row.serverKey,
				connectionExternalId: row.connectionExternalId,
				serverUrl: row.serverUrl,
				status: row.status,
				metadata: row.metadata,
			}));
		const wantedPieceNames = getMcpAvailabilityWantedPieceNames({
			registeredEntries,
			projectConnections,
		});
		const oauthPieceNames = getMcpAvailabilityOAuthPieceNames(wantedPieceNames);
		const oauthConfiguredPieceNames =
			oauthPieceNames.length > 0
				? await this.deps.mcpConnections.listPlatformOAuthAppPieceNames({
						pieceNames: oauthPieceNames,
						platformId: input.platformId,
					})
				: [];

		return buildMcpAvailability({
			registeredEntries,
			catalogPath,
			pieces,
			appConnections,
			projectConnections,
			oauthConfiguredPieceNames,
		});
	}

	private async getOrCreateHostedMcpServer(
		projectId: string,
	): Promise<HostedMcpServerRecord> {
		const existing = await this.deps.hostedMcpServers.getServerByProjectId(projectId);
		if (existing) return existing;
		return this.deps.hostedMcpServers.createServer({
			id: generateId(),
			projectId,
			status: "DISABLED",
			tokenEncrypted: encryptString(generateHostedMcpToken()),
		});
	}

	private async listHostedMcpWorkflows(projectId: string): Promise<HostedMcpWorkflow[]> {
		const ownerId = await this.deps.hostedMcpServers.getProjectOwnerId(projectId);
		if (!ownerId) return [];
		const rows = await this.deps.hostedMcpServers.listWorkflowSourcesForProject({
			projectId,
			ownerId,
		});

		const flows: HostedMcpWorkflow[] = [];
		for (const workflow of rows) {
			const trigger = getHostedMcpTriggerFromWorkflowNodes(workflow.nodes);
			if (!trigger) continue;
			flows.push({
				id: workflow.id,
				name: workflow.name,
				description: workflow.description,
				enabled: trigger.enabled,
				trigger: {
					toolName: trigger.toolName || workflow.name,
					toolDescription: trigger.toolDescription || "",
					inputSchema: trigger.inputSchema,
					returnsResponse: trigger.returnsResponse,
				},
			});
		}
		return flows;
	}

	private async populateHostedMcpServer(
		server: HostedMcpServerRecord,
	): Promise<HostedMcpServerReadModel> {
		const { tokenEncrypted, ...rest } = server;
		return {
			...rest,
			token: decryptString(tokenEncrypted),
			flows: await this.listHostedMcpWorkflows(server.projectId),
		};
	}

	private async syncHostedWorkflowMcpConnection(input: {
		projectId: string;
		status: HostedMcpServerStatus;
		actorUserId?: string | null;
		requestUrl?: string | null;
	}) {
		await this.deps.hostedMcpServers.upsertHostedWorkflowConnection({
			projectId: input.projectId,
			status: input.status,
			serverUrl: buildHostedMcpServerUrl(input.projectId, input.requestUrl),
			registryRef: "mcp-gateway",
			metadata: {
				provider: "workflow-builder",
				serviceName: "mcp-gateway",
				endpointPath: "/api/v1/projects/:projectId/mcp-server/http",
			},
			actorUserId: input.actorUserId ?? null,
			lastError: null,
		});
	}

	async getProjectHostedMcpServer(input: {
		projectId: string;
		userId: string;
		requestUrl?: string | null;
	}) {
		const membership = await this.deps.workspaceProjects.getProjectMembershipDetail({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (!membership?.selfRole) {
			return { ok: false as const, status: 403 as const, message: "Forbidden" };
		}

		const server = await this.populateHostedMcpServer(
			await this.getOrCreateHostedMcpServer(input.projectId),
		);
		await this.syncHostedWorkflowMcpConnection({
			projectId: input.projectId,
			status: server.status,
			actorUserId: input.userId,
			requestUrl: input.requestUrl,
		});
		return { ok: true as const, status: 200 as const, server };
	}

	async getInternalHostedMcpServer(input: { projectId?: string | null }) {
		const projectId = input.projectId?.trim();
		if (!projectId) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "Project id is required",
			};
		}
		const ownerId = await this.deps.hostedMcpServers.getProjectOwnerId(projectId);
		if (!ownerId) {
			return {
				ok: false as const,
				status: 404 as const,
				message: "Project not found",
			};
		}
		const server = await this.populateHostedMcpServer(
			await this.getOrCreateHostedMcpServer(projectId),
		);
		return { ok: true as const, status: 200 as const, server };
	}

	async getInternalProjectMcpCatalog(input: { projectRef?: string | null }) {
		const projectRef = input.projectRef?.trim();
		if (!projectRef) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "Project id is required",
			};
		}
		const project =
			await this.deps.hostedMcpServers.resolveProjectByIdOrExternalId(projectRef);
		if (!project) {
			return {
				ok: false as const,
				status: 404 as const,
				message: "Project not found",
			};
		}

		const hostedServer = await this.populateHostedMcpServer(
			await this.getOrCreateHostedMcpServer(project.id),
		);
		await this.syncHostedWorkflowMcpConnection({
			projectId: project.id,
			status: hostedServer.status,
		});

		const hostedGatewayBaseUrl =
			env.MCP_GATEWAY_INTERNAL_BASE_URL?.trim() ||
			"http://mcp-gateway.workflow-builder.svc.cluster.local:8080";
		const servers = (await this.deps.mcpConnections.listProjectConnections(project.id))
			.filter((connection) => connection.status === "ENABLED")
			.map((connection) =>
				buildProjectMcpCatalogEntry(connection, {
					hostedProjectId: project.id,
					hostedToken: hostedServer.token,
					hostedGatewayBaseUrl,
				}),
			)
			.filter((entry) => entry !== null);

		return {
			ok: true as const,
			status: 200 as const,
			catalog: {
				projectId: project.id,
				projectExternalId: project.externalId,
				servers,
			},
		};
	}

	async updateProjectHostedMcpServerStatus(input: {
		projectId: string;
		userId: string;
		status?: unknown;
		requestUrl?: string | null;
	}) {
		const membership = await this.deps.workspaceProjects.getProjectMembershipDetail({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (!canWriteHostedMcp(membership?.selfRole)) {
			return { ok: false as const, status: 403 as const, message: "Forbidden" };
		}
		if (input.status !== "ENABLED" && input.status !== "DISABLED") {
			return { ok: false as const, status: 400 as const, message: "Invalid status" };
		}

		const current = await this.getOrCreateHostedMcpServer(input.projectId);
		await this.deps.hostedMcpServers.updateServerStatus({
			id: current.id,
			status: input.status,
		});
		const server = await this.populateHostedMcpServer({
			...current,
			status: input.status,
			updatedAt: new Date(),
		});
		await this.syncHostedWorkflowMcpConnection({
			projectId: input.projectId,
			status: server.status,
			actorUserId: input.userId,
			requestUrl: input.requestUrl,
		});
		return { ok: true as const, status: 200 as const, server };
	}

	async rotateProjectHostedMcpServerToken(input: {
		projectId: string;
		userId: string;
		requestUrl?: string | null;
	}) {
		const membership = await this.deps.workspaceProjects.getProjectMembershipDetail({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (!canWriteHostedMcp(membership?.selfRole)) {
			return { ok: false as const, status: 403 as const, message: "Forbidden" };
		}

		const current = await this.getOrCreateHostedMcpServer(input.projectId);
		const tokenEncrypted = encryptString(generateHostedMcpToken());
		await this.deps.hostedMcpServers.updateServerToken({
			id: current.id,
			tokenEncrypted,
		});
		const server = await this.populateHostedMcpServer({
			...current,
			tokenEncrypted,
			updatedAt: new Date(),
		});
		await this.syncHostedWorkflowMcpConnection({
			projectId: input.projectId,
			status: server.status,
			actorUserId: input.userId,
			requestUrl: input.requestUrl,
		});
		return { ok: true as const, status: 200 as const, server };
	}

	getMcpRun(runId: string) {
		return this.deps.mcpRuns.getRun(runId);
	}

	respondToMcpRun(input: { runId: string; response: unknown }) {
		return this.deps.mcpRuns.respondToRun(input);
	}

	async startHostedMcpWorkflowTool(
		input: StartHostedMcpWorkflowToolInput,
	): Promise<StartHostedMcpWorkflowToolResult> {
		const projectId = input.projectId.trim();
		const workflowId = input.workflowId.trim();
		if (!projectId || !workflowId) {
			return {
				ok: false,
				status: 400,
				message: "Project id and workflow id are required",
			};
		}
		if (!this.deps.workflowScheduler) {
			return {
				ok: false,
				status: 503,
				message: "Workflow scheduler is not configured",
			};
		}

		try {
			await this.deps.workflowExecutions.assertReadModelReady();
		} catch (schemaError) {
			return {
				ok: false,
				status: 503,
				message:
					schemaError instanceof Error
						? schemaError.message
						: "Execution read-model migration is required",
			};
		}

		const ownerId = await this.deps.hostedMcpServers.getProjectOwnerId(projectId);
		if (!ownerId) {
			return { ok: false, status: 404, message: "Project not found" };
		}

		const workflow = await this.deps.workflowDefinitions.getById(workflowId);
		if (
			!workflow ||
			!(
				workflow.projectId === projectId ||
				(workflow.projectId === null && workflow.userId === ownerId)
			)
		) {
			return { ok: false, status: 404, message: "Workflow not found" };
		}

		const trigger = getHostedMcpTriggerFromWorkflowNodes(workflow.nodes);
		if (!trigger?.enabled) {
			return {
				ok: false,
				status: 400,
				message: "Workflow is not enabled as an MCP tool",
			};
		}

		const server = await this.getOrCreateHostedMcpServer(projectId);
		if (server.status !== "ENABLED") {
			return {
				ok: false,
				status: 403,
				message: "MCP access is disabled for this project",
			};
		}

		const spec = workflow.spec;
		if (!isServerlessWorkflow10Spec(spec)) {
			return {
				ok: false,
				status: 400,
				message: "Workflow does not have a valid CNCF Serverless Workflow 1.0 spec",
			};
		}

		const toolName =
			typeof input.toolName === "string" ? input.toolName : (trigger.toolName ?? workflow.name);
		const runInput = hostedMcpToolInput(input.input);
		const run = await this.deps.mcpRuns.createRun({
			projectId,
			mcpServerId: server.id,
			workflowId: workflow.id,
			toolName,
			input: runInput,
		});

		let triggerData: Record<string, unknown> = {
			__mcp: {
				runId: run.id,
				projectId,
				workflowId: workflow.id,
				toolName,
				returnsResponse: trigger.returnsResponse,
			},
			...runInput,
		};
		triggerData = applyWorkflowInputDefaults(spec, triggerData);
		if (getPromptExpansionConfig(spec)?.requiresExpansion) {
			triggerData = await expandGreenfieldPromptInput(spec, triggerData);
		}
		const missingTriggerFields = getMissingRequiredTriggerFields(spec, triggerData);
		if (missingTriggerFields.length > 0) {
			return {
				ok: false,
				status: 400,
				message: `Missing required workflow input fields: ${missingTriggerFields.join(", ")}`,
			};
		}

		const execution = await this.deps.workflowExecutions.create({
			workflowId: workflow.id,
			userId: workflow.userId,
			projectId,
			status: "running",
			phase: "running",
			progress: 0,
			input: triggerData,
			executionIrVersion: "sw-1.0",
			executionIr: { spec, triggerData },
		});

		let instanceId: string | null = null;
		try {
			const result = await this.deps.workflowScheduler.startSwWorkflow({
				orchestratorUrl: workflow.daprOrchestratorUrl || getOrchestratorUrl(),
				headers: hostedMcpTraceHeaders(input.traceHeaders),
				workflow: spec,
				workflowId,
				triggerData,
				dbExecutionId: execution.id,
			});
			instanceId = result.instanceId ?? null;
		} catch (err) {
			const message = err instanceof Error ? err.message : "Unknown error";
			console.error(`[MCP Execute] ${message}`);
			await this.deps.workflowExecutions.updateReadModel(execution.id, {
				status: "error",
				error: message.slice(0, 500),
			});
			return {
				ok: false,
				status: 502,
				message: `SW workflow failed: ${message}`,
			};
		}

		if (!instanceId) {
			const message = "Orchestrator did not return an instanceId";
			console.error(`[MCP Execute] ${message}`);
			await this.deps.workflowExecutions.updateReadModel(execution.id, {
				status: "error",
				error: message,
			});
			return {
				ok: false,
				status: 502,
				message: "SW workflow failed: missing instanceId",
			};
		}

		await this.deps.workflowExecutions.attachSchedulerInstance({
			executionId: execution.id,
			instanceId,
			workflowSessionId: execution.id,
		});

		await this.deps.mcpRuns.attachExecution({
			runId: run.id,
			workflowExecutionId: execution.id,
			daprInstanceId: instanceId,
		});

		return {
			ok: true,
			status: 200,
			runId: run.id,
			executionId: execution.id,
			instanceId,
			returnsResponse: trigger.returnsResponse,
		};
	}

	async listAppConnectionSummaries(input: {
		pieceName?: string | null;
		providerId?: string | null;
	}): Promise<AppConnectionSummary[]> {
		const pieceNameFilter = input.pieceName || input.providerId || null;
		const candidates = pieceNameFilter
			? appConnectionPieceCandidates(pieceNameFilter)
			: [];
		const [connections, pieces] = await Promise.all([
			this.deps.appConnections.listConnectionSummaries({
				pieceNameCandidates: candidates,
			}),
			this.deps.appConnections.listPieceInfo(),
		]);

		const pieceMap = new Map<
			string,
			{ displayName: string | null; logoUrl: string | null }
		>();
		for (const piece of pieces) {
			const info = {
				displayName: piece.displayName ?? null,
				logoUrl: piece.logoUrl ?? null,
			};
			for (const candidate of appConnectionPieceCandidates(piece.name)) {
				pieceMap.set(candidate.toLowerCase(), info);
			}
			pieceMap.set(normalizeMcpPieceName(piece.name), info);
			pieceMap.set(piece.name.toLowerCase(), info);
		}

		return connections.map((connection) => {
			const meta =
				pieceMap.get(normalizeMcpPieceName(connection.pieceName)) ??
				pieceMap.get(connection.pieceName.toLowerCase()) ??
				null;
			return {
				...connection,
				pieceDisplayName: meta?.displayName ?? null,
				pieceLogoUrl: meta?.logoUrl ?? null,
			};
		});
	}

	async listProjectAppConnections(input: {
		projectId: string;
		pieceName?: string | null;
		provider?: string | null;
		search?: string | null;
		status?: string | null;
		type?: string | null;
		scope?: string | null;
	}): Promise<AppConnectionListItem[]> {
		const [
			connections,
			pieces,
		] = await Promise.all([
			this.deps.appConnections.listProjectConnections(input.projectId),
			this.deps.appConnections.listPieceInfo(),
		]);

		const pieceMap = new Map<
			string,
			{ name: string; displayName: string; logoUrl: string | null; categories: string[] }
		>();
		for (const piece of pieces) {
			const info = {
				name: piece.name,
				displayName: piece.displayName,
				logoUrl: piece.logoUrl,
				categories: Array.isArray(piece.categories) ? piece.categories : [],
			};
			for (const candidate of appConnectionPieceCandidates(piece.name)) {
				pieceMap.set(candidate.toLowerCase(), info);
			}
			pieceMap.set(normalizeMcpPieceName(piece.name), info);
			pieceMap.set(piece.name.toLowerCase(), info);
			pieceMap.set(piece.displayName.toLowerCase(), info);
		}

		const pieceNameFilter = input.pieceName?.trim() ?? "";
		const providerFilter = input.provider?.trim() ?? "";
		const searchFilter = input.search?.trim().toLowerCase() ?? "";
		const statusFilter = input.status?.trim().toUpperCase() ?? "";
		const typeFilter = input.type?.trim().toUpperCase() ?? "";
		const scopeFilter = input.scope?.trim().toUpperCase() ?? "";

		return connections
			.map((connection) => {
				const normalizedPieceName = normalizeMcpPieceName(connection.pieceName);
				const piece =
					pieceMap.get(connection.pieceName.toLowerCase()) ??
					pieceMap.get(normalizedPieceName) ??
					pieceMap.get(
						appConnectionPieceCandidates(connection.pieceName)[0]?.toLowerCase() ||
							"",
					);
				const { projectIds: _projectIds, ...publicConnection } = connection;
				return {
					...publicConnection,
					providerId: piece?.name ? normalizeMcpPieceName(piece.name) : normalizedPieceName,
					providerLabel: piece?.displayName || humanizeMcpPieceName(connection.pieceName),
					providerIconUrl: piece?.logoUrl || null,
					category: piece?.categories?.[0] || null,
				};
			})
			.filter((connection) => {
				const piece = pieceMap.get(normalizeMcpPieceName(connection.pieceName));
				return (
					appConnectionMatchesPieceFilter(
						connection.pieceName,
						pieceNameFilter,
						piece,
					) &&
					appConnectionMatchesPieceFilter(
						connection.pieceName,
						providerFilter,
						piece,
					) &&
					(!statusFilter || connection.status === statusFilter) &&
					(!typeFilter || connection.type === typeFilter) &&
					(!scopeFilter || connection.scope === scopeFilter) &&
					(!searchFilter ||
						[
							connection.displayName,
							connection.pieceName,
							connection.providerId,
							connection.providerLabel,
							connection.category || "",
						]
							.join(" ")
							.toLowerCase()
							.includes(searchFilter))
				);
			});
	}

	async createProjectAppConnection(input: AppConnectionCreateInput) {
		if (!input.pieceName || !input.displayName || !input.type) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "pieceName, displayName, and type are required",
			};
		}

		const normalizedType = String(input.type).toUpperCase() as AppConnectionType;
		const supportedTypes = new Set<string>(Object.values(AppConnectionType));
		if (!supportedTypes.has(normalizedType)) {
			return {
				ok: false as const,
				status: 400 as const,
				message: `Unsupported connection type: ${input.type}`,
			};
		}

		if (normalizedType === AppConnectionType.SECRET_TEXT && !input.value) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "value is required for SECRET_TEXT connections",
			};
		}

		const isOAuth =
			normalizedType === AppConnectionType.OAUTH2 ||
			normalizedType === AppConnectionType.PLATFORM_OAUTH2 ||
			normalizedType === AppConnectionType.CLOUD_OAUTH2;
		const rawValue =
			input.value && typeof input.value === "object" && !Array.isArray(input.value)
				? (input.value as Record<string, unknown>)
				: typeof input.value === "string"
					? { secret_text: input.value }
					: {};
		const encryptedValue = encryptObject({
			type: normalizedType,
			...rawValue,
		});

		const id = generateId();
		const scope =
			input.scope === AppConnectionScope.PLATFORM
				? AppConnectionScope.PLATFORM
				: AppConnectionScope.PROJECT;
		const connection = await this.deps.appConnections.createConnection({
			id,
			externalId: `conn_${id}`,
			pieceName: String(input.pieceName),
			displayName: String(input.displayName).trim(),
			type: normalizedType,
			status: isOAuth ? AppConnectionStatus.MISSING : AppConnectionStatus.ACTIVE,
			value: encryptedValue,
			pieceVersion: "0.0.0",
			projectIds: [input.projectId],
			ownerId: input.userId ?? null,
			platformId: input.platformId ?? null,
			scope,
		});
		return { ok: true as const, connection };
	}

	async updateProjectAppConnection(input: {
		id: string;
		projectId: string;
		displayName?: unknown;
	}) {
		const displayName =
			typeof input.displayName === "string" ? input.displayName.trim() : "";
		if (!displayName) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "displayName is required",
			};
		}
		const connection = await this.deps.appConnections.updateDisplayName({
			id: input.id,
			projectId: input.projectId,
			displayName,
		});
		if (!connection) {
			return { ok: false as const, status: 404 as const, message: "Connection not found" };
		}
		return { ok: true as const, connection };
	}

	async deleteProjectAppConnection(input: { id: string; projectId: string }) {
		const deleted = await this.deps.appConnections.deleteProjectConnection(input);
		if (!deleted) {
			return { ok: false as const, status: 404 as const, message: "Connection not found" };
		}
		return { ok: true as const };
	}

	async startAppConnectionOAuth2(input: {
		pieceName?: unknown;
		pieceVersion?: unknown;
		clientId?: unknown;
		redirectUrl: string;
		props?: unknown;
	}) {
		const pieceName = typeof input.pieceName === "string" ? input.pieceName.trim() : "";
		if (!pieceName) {
			return { ok: false as const, status: 400 as const, message: "pieceName is required" };
		}

		const piece = await this.deps.appConnections.findOAuthPieceMetadata({
			pieceNameCandidates: appConnectionPieceCandidates(pieceName),
			pieceVersion:
				typeof input.pieceVersion === "string" ? input.pieceVersion : null,
		});
		if (!piece) {
			return { ok: false as const, status: 404 as const, message: "Piece not found" };
		}

		const oauthAuth = getOAuth2AuthConfig(piece);
		if (!oauthAuth?.authUrl) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "Piece does not define OAuth2 auth URL",
			};
		}

		let clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
		if (!clientId) {
			const oauthApp = await this.deps.appConnections.findPlatformOAuthApp({
				pieceNameCandidates: appConnectionPieceCandidates(pieceName),
			});
			if (!oauthApp) {
				return {
					ok: false as const,
					status: 400 as const,
					message:
						"No OAuth app configured for this piece. Configure it in Settings > OAuth Apps.",
				};
			}
			clientId = oauthApp.clientId;
		}

		const props =
			input.props && typeof input.props === "object" && !Array.isArray(input.props)
				? (input.props as Record<string, unknown>)
				: undefined;
		const verifier = generatePkceVerifier();
		const pkceEnabled = oauthAuth.pkce ?? false;
		const pkceMethod = oauthAuth.pkceMethod ?? "plain";
		const challenge = pkceEnabled
			? pkceMethod === "S256"
				? generatePkceChallenge(verifier)
				: verifier
			: "";
		const state = generateOAuthState();
		const scope = (oauthAuth.scope ?? []).map((entry) =>
			resolveValueFromProps(entry, props),
		);
		const extraParams = oauthAuth.extra
			? Object.fromEntries(
					Object.entries(oauthAuth.extra).map(([key, value]) => [
						key,
						resolveValueFromProps(value, props),
					]),
				)
			: undefined;

		return {
			ok: true as const,
			authorizationUrl: buildOAuth2AuthorizationUrl({
				authUrl: resolveValueFromProps(oauthAuth.authUrl, props),
				clientId,
				redirectUrl: input.redirectUrl,
				scope,
				state,
				codeChallenge: pkceEnabled ? challenge : undefined,
				codeChallengeMethod: pkceMethod,
				prompt: oauthAuth.prompt,
				extraParams,
			}),
			clientId,
			state,
			codeVerifier: pkceEnabled ? verifier : "",
			codeChallenge: pkceEnabled ? challenge : "",
			redirectUrl: input.redirectUrl,
			scope: scope.join(" "),
		};
	}

	async completeAppConnectionOAuth2(input: {
		projectId: string;
		connectionId?: unknown;
		pieceName?: unknown;
		code?: unknown;
		codeVerifier?: unknown;
		redirectUrl?: unknown;
		defaultRedirectUrl: string;
	}) {
		const connectionId =
			typeof input.connectionId === "string" ? input.connectionId.trim() : "";
		const pieceName = typeof input.pieceName === "string" ? input.pieceName.trim() : "";
		const code = typeof input.code === "string" ? input.code.trim() : "";
		if (!connectionId || !pieceName || !code) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "connectionId, pieceName, and code are required",
			};
		}

		const connection = await this.deps.appConnections.findConnectionById(connectionId);
		if (!connection || !connectionBelongsToProject(connection.projectIds, input.projectId)) {
			return { ok: false as const, status: 404 as const, message: "Connection not found" };
		}

		const connectionValue = decryptObject<Record<string, unknown>>(
			connection.value as EncryptedObject,
		);
		const connectionProps =
			connectionValue.props &&
			typeof connectionValue.props === "object" &&
			!Array.isArray(connectionValue.props)
				? (connectionValue.props as Record<string, unknown>)
				: undefined;
		const pieceNameCandidates = appConnectionPieceCandidates(pieceName);
		const piece = await this.deps.appConnections.findOAuthPieceMetadata({
			pieceNameCandidates,
		});
		if (!piece) {
			return { ok: false as const, status: 404 as const, message: "Piece not found" };
		}

		const oauthAuth = getOAuth2AuthConfig(piece);
		if (!oauthAuth?.tokenUrl) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "Piece does not define OAuth2 token URL",
			};
		}

		const oauthApp = await this.deps.appConnections.findPlatformOAuthApp({
			pieceNameCandidates,
			platformId: connection.platformId,
		});
		if (!oauthApp) {
			return {
				ok: false as const,
				status: 400 as const,
				message:
					"No OAuth app configured for this piece. Configure it in Settings > OAuth Apps.",
			};
		}

		const authorizationMethod =
			(typeof connectionValue.authorization_method === "string"
				? connectionValue.authorization_method
				: oauthAuth.authorizationMethod) as OAuth2AuthorizationMethod | undefined;
		const redirectUrl =
			typeof input.redirectUrl === "string" && input.redirectUrl.trim()
				? input.redirectUrl.trim()
				: typeof connectionValue.redirect_url === "string" &&
					  connectionValue.redirect_url.trim()
					? connectionValue.redirect_url.trim()
					: input.defaultRedirectUrl;
		const tokenValue = await exchangeOAuth2CodePlatform({
			code,
			tokenUrl: resolveValueFromProps(oauthAuth.tokenUrl, connectionProps),
			clientId: oauthApp.clientId,
			clientSecret: resolveAppConnectionClientSecret(oauthApp.clientSecret),
			redirectUrl,
			scope: (oauthAuth.scope ?? [])
				.map((entry) => resolveValueFromProps(entry, connectionProps))
				.join(" "),
			props: connectionProps,
			authorizationMethod,
			codeVerifier:
				typeof input.codeVerifier === "string" ? input.codeVerifier : undefined,
		});

		const updated = await this.deps.appConnections.updateOAuthConnection({
			id: connection.id,
			value: encryptObject(tokenValue as unknown as Record<string, unknown>),
			pieceName,
			pieceVersion: piece.version,
			projectIds: mergeConnectionProjectId(connection.projectIds, input.projectId),
		});
		return { ok: true as const, connection: updated };
	}

	private async refreshOAuth2Token(
		token: Record<string, unknown>,
		pieceName: string,
	): Promise<Record<string, unknown> | null> {
		const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : "";
		const tokenUrl = typeof token.token_url === "string" ? token.token_url : "";
		if (!refreshToken || !tokenUrl) return null;

		const oauthApp = await this.deps.appConnections.findPlatformOAuthApp({
			pieceNameCandidates: appConnectionPieceCandidates(pieceName),
		});
		if (!oauthApp) return null;

		let clientSecret: string;
		try {
			clientSecret = resolveAppConnectionClientSecret(oauthApp.clientSecret);
		} catch {
			return null;
		}

		const clientId =
			typeof token.client_id === "string" && token.client_id
				? token.client_id
				: oauthApp.clientId;
		const authMethod =
			typeof token.authorization_method === "string"
				? token.authorization_method
				: "BODY";
		const body: Record<string, string> = {
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		};
		const headers: Record<string, string> = {
			"Content-Type": "application/x-www-form-urlencoded",
		};
		if (authMethod === "HEADER") {
			headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
		} else {
			body.client_id = clientId;
			body.client_secret = clientSecret;
		}

		try {
			const response = await fetch(tokenUrl, {
				method: "POST",
				headers,
				body: new URLSearchParams(body).toString(),
				signal: AbortSignal.timeout(20000),
			});
			if (!response.ok) return null;
			const data = (await response.json()) as Record<string, unknown>;
			return {
				...token,
				access_token: data.access_token ?? token.access_token,
				token_type: data.token_type ?? token.token_type,
				expires_in: data.expires_in ?? token.expires_in,
				scope: data.scope ?? token.scope,
				refresh_token: data.refresh_token ?? token.refresh_token,
				claimed_at: Math.floor(Date.now() / 1000),
				data: {
					...((token.data as Record<string, unknown> | undefined) ?? {}),
					...((data.data as Record<string, unknown> | undefined) ?? {}),
				},
			};
		} catch {
			return null;
		}
	}

	async decryptAppConnectionValue(input: { externalId: string }) {
		const connection = await this.deps.appConnections.findConnectionByExternalId(
			input.externalId,
		);
		if (!connection) {
			return { ok: false as const, status: 404 as const, message: "Connection not found" };
		}

		let decryptedValue = decryptObject<Record<string, unknown>>(
			connection.value as EncryptedObject,
		);
		const isOAuth2 =
			connection.type === AppConnectionType.OAUTH2 ||
			connection.type === AppConnectionType.PLATFORM_OAUTH2 ||
			connection.type === AppConnectionType.CLOUD_OAUTH2;

		if (isOAuth2 && decryptedValue.secret_text && !decryptedValue.access_token) {
			const secretText = String(decryptedValue.secret_text);
			try {
				const parsed = JSON.parse(secretText) as Record<string, unknown>;
				decryptedValue =
					parsed && typeof parsed === "object" && parsed.access_token
						? { ...parsed, type: parsed.type || connection.type }
						: { ...decryptedValue, access_token: secretText, type: connection.type };
			} catch {
				decryptedValue = {
					...decryptedValue,
					access_token: secretText,
					type: connection.type,
				};
			}
		}

		if (isOAuth2 && isTokenExpired(decryptedValue)) {
			const refreshed = await this.refreshOAuth2Token(
				decryptedValue,
				connection.pieceName,
			);
			if (refreshed) {
				await this.deps.appConnections.updateEncryptedValue({
					id: connection.id,
					value: encryptObject(refreshed),
				});
				decryptedValue = refreshed;
			}
		}

		if (
			connection.type === AppConnectionType.PLATFORM_OAUTH2 &&
			!decryptedValue.client_secret &&
			decryptedValue.client_id
		) {
			const oauthApp = await this.deps.appConnections.findPlatformOAuthApp({
				pieceNameCandidates: appConnectionPieceCandidates(connection.pieceName),
				platformId: connection.platformId,
			});
			if (oauthApp) {
				try {
					decryptedValue.client_secret = resolveAppConnectionClientSecret(
						oauthApp.clientSecret,
					);
				} catch {
					// Leave the token usable for callers that do not need client_secret.
				}
			}
		}

		if (
			connection.type === AppConnectionType.PLATFORM_OAUTH2 &&
			typeof decryptedValue.claimed_at === "number" &&
			!decryptedValue.expiry_date
		) {
			const expiresIn =
				typeof decryptedValue.expires_in === "number" ? decryptedValue.expires_in : 3600;
			decryptedValue.expiry_date = (decryptedValue.claimed_at + expiresIn) * 1000;
		}

		return {
			ok: true as const,
			connection: {
				id: connection.id,
				externalId: connection.externalId,
				type: connection.type,
				pieceName: connection.pieceName,
				displayName: connection.displayName,
				status: connection.status,
				value: decryptedValue,
			},
		};
	}

	async getAdminPiecesReadModel(): Promise<AdminPiecesReadModel> {
		const [bundled, availableRows, disabled, wfRefs, mcpEnabled] =
			await Promise.all([
				this.deps.adminPieces.listCatalogPieces({ availableOnly: false }),
				this.deps.adminPieces.listCatalogPieces({ availableOnly: true }),
				this.deps.adminPieces.listDisabledPieceNames(),
				this.deps.adminPieces.listWorkflowReferencedPieceNames(),
				this.deps.adminPieces.listEnabledMcpPieceNames(),
			]);

		const disabledSet = new Set(disabled);
		const inUse = new Set([...wfRefs, ...mcpEnabled]);
		const bundledNames = bundled
			.map((piece) => piece.name)
			.filter((name): name is string => Boolean(name));
		const availableNames = availableRows
			.map((piece) => piece.name)
			.filter((name): name is string => Boolean(name));
		const imageStatuses = new Map(
			(
				await this.deps.adminPieces.listLatestImageStatuses([
					...bundledNames,
					...availableNames,
				])
			).map((status) => [status.pieceName, status]),
		);
		const enabledByImage = (name: string) => {
			const img = imageStatuses.get(name);
			return img?.status === "ready" && img.enabled === true;
		};

		const bundledPieces = bundled
			.filter(hasAdminPieceName)
			.map((piece) => ({
				name: piece.name,
				displayName: piece.displayName ?? piece.name,
				logoUrl: piece.logoUrl ?? "",
				enabled: !disabledSet.has(piece.name),
				inUse: inUse.has(piece.name),
				pinned: PINNED_ADMIN_PIECES.has(piece.name),
				perPiece: imageStatuses.get(piece.name)?.status === "ready",
			}));

		const perPieceEnabled = availableRows
			.filter(hasAdminPieceName)
			.filter((piece) => enabledByImage(piece.name))
			.map((piece) => ({
				name: piece.name,
				displayName: piece.displayName ?? piece.name,
				logoUrl: piece.logoUrl ?? "",
				enabled: !disabledSet.has(piece.name),
				inUse: inUse.has(piece.name),
				pinned: PINNED_ADMIN_PIECES.has(piece.name),
				perPiece: true,
			}));

		const uniqueByName = <T extends { name: string }>(rows: T[]): T[] =>
			[...new Map(rows.map((row) => [row.name, row])).values()];
		const pieces = uniqueByName([...bundledPieces, ...perPieceEnabled]).sort((a, b) =>
			a.displayName.localeCompare(b.displayName),
		);

		const available = uniqueByName(
			availableRows
				.filter(hasAdminPieceName)
				.filter((piece) => !enabledByImage(piece.name))
				.map((piece) => {
					const img = imageStatuses.get(piece.name);
					const buildStatus: "building" | "ready" | "failed" | null =
						img?.status === "building" ||
						img?.status === "ready" ||
						img?.status === "failed"
							? img.status
							: null;
					return {
						name: piece.name,
						displayName: piece.displayName ?? piece.name,
						logoUrl: piece.logoUrl ?? "",
						buildStatus,
						errorMessage: img?.errorMessage ?? null,
					};
				}),
		).sort((a, b) => a.displayName.localeCompare(b.displayName));

		return {
			pieces,
			available,
			total: pieces.length,
			enabledCount: pieces.filter((piece) => piece.enabled).length,
			availableCount: available.length,
		};
	}

	setAdminPieceEnabled(input: {
		pieceName: string;
		enabled: boolean;
		disabledBy?: string | null;
	}) {
		return this.deps.adminPieces.setPieceEnabled(input);
	}

	resolveWorkspaceProjectId(input: {
		slug?: string | null;
		userId: string;
		currentProjectId: string;
	}) {
		const slug = input.slug?.trim();
		if (!slug || slug === "default") {
			return this.deps.workspaceProjects.getMemberProjectId({
				projectId: input.currentProjectId,
				userId: input.userId,
			});
		}
		return this.deps.workspaceProjects.getMemberProjectIdBySlug({
			slug,
			userId: input.userId,
		});
	}

	async resolveSessionProjectId(input: {
		userId: string;
		currentProjectId: string;
	}): Promise<string | null> {
		const current = await this.deps.workspaceProjects.getMemberProjectId({
			projectId: input.currentProjectId,
			userId: input.userId,
		});
		if (current) return current;
		return this.deps.workspaceProjects.getFallbackMemberProjectId(input.userId);
	}

	getExecutionWorkspaceRoute(
		executionId: string,
	): Promise<ExecutionWorkspaceRouteInfo | null> {
		return this.deps.workflowExecutions.getExecutionWorkspaceRoute(executionId);
	}

	async listWorkspaces(input: {
		userId: string;
		currentProjectId: string;
	}): Promise<WorkspaceSummary[]> {
		const rows = await this.deps.workspaceProjects.listWorkspaceMemberships({
			userId: input.userId,
		});
		return rows.map((row) =>
			workspaceSummaryFromRecord(row, input.currentProjectId),
		);
	}

	async createWorkspace(input: {
		displayName: string;
		externalId?: string;
		userId: string;
		platformId: string;
	}): Promise<WorkspaceSummary> {
		const externalId = (input.externalId || workspaceSlugify(input.displayName)).slice(
			0,
			60,
		);
		const row = await this.deps.workspaceProjects.createWorkspaceProject({
			platformId: input.platformId,
			ownerId: input.userId,
			displayName: input.displayName,
			externalId,
		});
		return workspaceSummaryFromRecord(row, null);
	}

	async renameWorkspace(input: {
		projectId: string;
		userId: string;
		displayName: string;
	}): Promise<boolean> {
		const role = await this.deps.workspaceProjects.getProjectMemberRole({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (role !== "ADMIN") return false;
		return this.deps.workspaceProjects.updateWorkspaceDisplayName({
			projectId: input.projectId,
			displayName: input.displayName,
		});
	}

	getWorkspaceProjectExternalId(projectId: string) {
		return this.deps.workspaceProjects.getProjectExternalId(projectId);
	}

	getWorkspaceProjectMembershipDetail(input: {
		projectId: string;
		userId: string;
	}) {
		return this.deps.workspaceProjects.getProjectMembershipDetail(input);
	}

	private requireUsageReporting(): UsageReportingRepository {
		if (!this.deps.usageReporting) {
			throw new Error("Usage reporting repository not configured");
		}
		return this.deps.usageReporting;
	}

	private requireSandboxInventory(): SandboxInventoryRepository {
		if (!this.deps.sandboxInventory) {
			throw new Error("Sandbox inventory repository not configured");
		}
		return this.deps.sandboxInventory;
	}

	private async requireProjectAdmin(input: {
		projectId: string;
		userId: string;
	}): Promise<{ ok: true } | { ok: false; status: 403; message: string }> {
		const role = await this.deps.workspaceProjects.getProjectMemberRole(input);
		if (role !== "ADMIN") {
			return { ok: false, status: 403, message: "Forbidden" };
		}
		return { ok: true };
	}

	async listProjectMembers(input: { projectId: string; userId: string }) {
		const selfRole = await this.deps.workspaceProjects.getProjectMemberRole({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (!selfRole) return { ok: false as const, status: 403 as const, message: "Forbidden" };
		const members = await this.deps.workspaceProjects.listProjectMembers(input.projectId);
		return { ok: true as const, status: 200 as const, members, selfRole };
	}

	async addProjectMember(input: {
		projectId: string;
		userId: string;
		targetUserId?: unknown;
		email?: unknown;
		role?: unknown;
	}) {
		const admin = await this.requireProjectAdmin({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (!admin.ok) return admin;

		const role = isProjectMembershipRole(input.role) ? input.role : "VIEWER";
		const targetUserId =
			typeof input.targetUserId === "string" && input.targetUserId.trim()
				? input.targetUserId.trim()
				: null;
		const email =
			typeof input.email === "string" && input.email.trim()
				? input.email.trim().toLowerCase()
				: null;
		if (!targetUserId && !email) {
			return {
				ok: false as const,
				status: 400 as const,
				message: "email or userId is required",
			};
		}

		const target = await this.deps.workspaceProjects.findPlatformUserForProject({
			projectId: input.projectId,
			userId: targetUserId,
			email,
		});
		if (!target.ok) {
			if (target.reason === "project_not_found") {
				return { ok: false as const, status: 404 as const, message: "Project not found" };
			}
			if (target.reason === "user_not_found") {
				return {
					ok: false as const,
					status: 404 as const,
					message: targetUserId
						? "User not found"
						: "No user with that email. Ask them to sign up first.",
				};
			}
			return {
				ok: false as const,
				status: 403 as const,
				message: "User is not part of this platform",
			};
		}

		const exists = await this.deps.workspaceProjects.projectMemberExists({
			projectId: input.projectId,
			userId: target.userId,
		});
		if (exists) {
			return {
				ok: false as const,
				status: 409 as const,
				message: "User is already a member",
			};
		}

		const member = await this.deps.workspaceProjects.addProjectMember({
			projectId: input.projectId,
			userId: target.userId,
			role,
		});
		return { ok: true as const, status: 201 as const, member };
	}

	async updateProjectMemberRole(input: {
		projectId: string;
		memberId: string;
		userId: string;
		role?: unknown;
	}) {
		const admin = await this.requireProjectAdmin({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (!admin.ok) return admin;
		if (!isProjectMembershipRole(input.role)) {
			return {
				ok: false as const,
				status: 400 as const,
				message: `role must be one of ${PROJECT_MEMBERSHIP_ROLES.join(", ")}`,
			};
		}

		const existing = await this.deps.workspaceProjects.getProjectMember({
			projectId: input.projectId,
			memberId: input.memberId,
		});
		if (!existing) {
			return { ok: false as const, status: 404 as const, message: "Member not found" };
		}

		if (existing.role === "ADMIN" && input.role !== "ADMIN") {
			const admins = await this.deps.workspaceProjects.countProjectAdmins(input.projectId);
			if (admins <= 1) {
				return {
					ok: false as const,
					status: 400 as const,
					message: "Cannot demote the last admin",
				};
			}
		}

		const member = await this.deps.workspaceProjects.updateProjectMemberRole({
			projectId: input.projectId,
			memberId: input.memberId,
			role: input.role,
		});
		if (!member) {
			return { ok: false as const, status: 404 as const, message: "Member not found" };
		}
		return { ok: true as const, status: 200 as const, member };
	}

	async deleteProjectMember(input: {
		projectId: string;
		memberId: string;
		userId: string;
	}) {
		const admin = await this.requireProjectAdmin({
			projectId: input.projectId,
			userId: input.userId,
		});
		if (!admin.ok) return admin;

		const existing = await this.deps.workspaceProjects.getProjectMember({
			projectId: input.projectId,
			memberId: input.memberId,
		});
		if (!existing) {
			return { ok: false as const, status: 404 as const, message: "Member not found" };
		}

		if (existing.role === "ADMIN") {
			const admins = await this.deps.workspaceProjects.countProjectAdmins(input.projectId);
			if (admins <= 1) {
				return {
					ok: false as const,
					status: 400 as const,
					message: "Cannot remove the last admin",
				};
			}
		}

		await this.deps.workspaceProjects.deleteProjectMember({
			projectId: input.projectId,
			memberId: input.memberId,
		});
		return { ok: true as const, status: 200 as const };
	}

	async getUsageAnalytics(input: {
		userId: string;
		projectId?: string | null;
		start?: string | null;
		end?: string | null;
		groupBy?: string | null;
		now?: Date;
	}) {
		const now = input.now ?? new Date();
		const start = parseDateOrDefault(input.start, usageMonthStart(now));
		const end = parseDateOrDefault(input.end, now);
		const snapshot = await this.requireUsageReporting().getUsageAnalytics({
			scope: { userId: input.userId, projectId: input.projectId },
			start,
			end,
		});
		return {
			range: { start: start.toISOString(), end: end.toISOString() },
			groupBy: input.groupBy ?? "day",
			totals: snapshot.totals,
			daily: snapshot.daily,
			byAgent: snapshot.byAgent,
		};
	}

	async getCostBreakdown(input: {
		userId: string;
		projectId?: string | null;
		start?: string | null;
		end?: string | null;
		now?: Date;
	}) {
		const now = input.now ?? new Date();
		const start = parseDateOrDefault(
			input.start,
			new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
		);
		const end = parseDateOrDefault(input.end, now);
		const rows = await this.requireUsageReporting().listCostUsageRows({
			scope: { userId: input.userId, projectId: input.projectId },
			start,
			end,
		});

		let totalCost = 0;
		const byAgent = new Map<
			string,
			{ agentId: string; agentName: string; sessions: number; cost: number }
		>();
		const byModel = new Map<
			string,
			{ model: string; sessions: number; inputTokens: number; outputTokens: number; cost: number }
		>();

		for (const row of rows) {
			const usage = {
				inputTokens: row.inputTokens,
				outputTokens: row.outputTokens,
				cacheReadTokens: row.cacheReadTokens,
				cacheCreateTokens: row.cacheCreateTokens,
			};
			const rowCost = costFor(row.modelSpec, usage);
			totalCost += rowCost;

			const agentKey = row.agentId;
			const agentEntry = byAgent.get(agentKey) ?? {
				agentId: row.agentId,
				agentName: row.agentName ?? row.agentId,
				sessions: 0,
				cost: 0,
			};
			agentEntry.sessions += row.sessions;
			agentEntry.cost += rowCost;
			byAgent.set(agentKey, agentEntry);

			const modelKey = row.modelSpec ?? "unknown";
			const modelEntry = byModel.get(modelKey) ?? {
				model: modelKey,
				sessions: 0,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			};
			modelEntry.sessions += row.sessions;
			modelEntry.inputTokens += usage.inputTokens;
			modelEntry.outputTokens += usage.outputTokens;
			modelEntry.cost += rowCost;
			byModel.set(modelKey, modelEntry);
		}

		return {
			range: { start: start.toISOString(), end: end.toISOString() },
			totalCost,
			priceBook: Object.entries(MODEL_PRICING).map(([model, p]) => ({
				model,
				inputPerMillion: p.inputPerMillion,
				outputPerMillion: p.outputPerMillion,
			})),
			byAgent: [...byAgent.values()].sort((a, b) => b.cost - a.cost),
			byModel: [...byModel.values()].sort((a, b) => b.cost - a.cost),
		};
	}

	async getLiveLimitSnapshot(input: {
		userId: string;
		projectId?: string | null;
		now?: Date;
	}) {
		const now = input.now ?? new Date();
		const snapshot = await this.requireUsageReporting().getLiveLimitSnapshot({
			scope: { userId: input.userId, projectId: input.projectId },
			now,
		});
		return {
			activeSessions: snapshot.activeSessions,
			byModel: snapshot.byModel,
			asOf: now.toISOString(),
		};
	}

	async listSandboxExecutions(sandboxName: string) {
		const rows = await this.requireSandboxInventory().listRecentExecutionsForSandbox(sandboxName);
		return rows.map((row) => ({
			executionId: row.executionId,
			workflowId: row.workflowId,
			workflowName: row.workflowName ?? "Unknown",
			status: row.status,
			startedAt: row.startedAt?.toISOString() ?? null,
			completedAt: row.completedAt?.toISOString() ?? null,
		}));
	}

	async getSandboxStats(input: { now?: Date } = {}) {
		const sandboxes = await this.deps.sandboxRuntimeInventory
			?.listSandboxes()
			.catch(() => []);
		const sandboxRows = sandboxes ?? [];
		const byPhase: Record<string, number> = {};
		for (const sandbox of sandboxRows) {
			const phase = String(sandbox.phase ?? "UNKNOWN");
			byPhase[phase] = (byPhase[phase] ?? 0) + 1;
		}

		const now = input.now ?? new Date();
		const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		const executions24h = await this.requireSandboxInventory()
			.countExecutionsSince(cutoff)
			.catch(() => 0);

		const ages = sandboxRows
			.map((sandbox) => {
				const created = sandbox.createdAt ? new Date(String(sandbox.createdAt)).getTime() : 0;
				return created > 0 ? (now.getTime() - created) / 60000 : 0;
			})
			.filter((age) => age > 0);
		const avgAgeMinutes =
			ages.length > 0
				? Math.round(ages.reduce((total, age) => total + age, 0) / ages.length)
				: 0;

		return {
			total: sandboxRows.length,
			byPhase,
			executions24h,
			avgAgeMinutes,
		};
	}

	async getWorkflowByRef(ref: WorkflowRef & { lookup?: "id" | "name" | "auto" }) {
		if (ref.lookup === "id") {
			const workflowId = ref.workflowId?.trim();
			return workflowId ? this.deps.workflowDefinitions.getById(workflowId) : null;
		}
		if (ref.lookup === "name") {
			const workflowName = ref.workflowName?.trim();
			return workflowName
				? this.deps.workflowDefinitions.getLatestByName(workflowName)
				: null;
		}
		const workflowId = ref.workflowId?.trim();
		if (workflowId) {
			const workflow = await this.deps.workflowDefinitions.getById(workflowId);
			if (workflow) return workflow;
		}
		const workflowName = ref.workflowName?.trim();
		return workflowName
			? this.deps.workflowDefinitions.getLatestByName(workflowName)
			: null;
	}

	listActiveWorkflowExecutionsForUser(userId: string) {
		return this.deps.workflowExecutions.listActiveForUser(userId);
	}

	listInternalAgentWorkflowExecutions(input: {
		workflowId?: string | null;
		workflowName?: string | null;
		status?: "pending" | "running" | "success" | "error" | "cancelled" | null;
		limit: number;
		offset: number;
	}) {
		return this.deps.workflowExecutions.listForInternalAgent(input);
	}

	listWorkflows(input: { limit: number; projectId?: string | null }) {
		return this.deps.workflowDefinitions.list(input);
	}

	async listWorkspaceWorkflowSummaries(input: {
		limit: number;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkspaceWorkflowListItem[]> {
		const rows = await this.deps.workflowDefinitions.listForWorkspace(input);
		if (rows.length === 0) return [];

		const workflowIds = rows.map((row) => row.id);
		const [forkCounts, recentRuns] = await Promise.all([
			this.deps.workflowExecutions.countForksByWorkflowIds(workflowIds),
			this.deps.workflowExecutions.listRecentRunsByWorkflowIds({
				workflowIds,
				limitPerWorkflow: 3,
			}),
		]);
		const forkCountByWorkflow = new Map(
			forkCounts.map((row) => [row.workflowId, row.count]),
		);
		const recentRunsByWorkflow = new Map<
			string,
			WorkspaceWorkflowListItem["recentRuns"]
		>();
		for (const run of recentRuns) {
			const list = recentRunsByWorkflow.get(run.workflowId) ?? [];
			list.push({
				id: run.id,
				status: run.status,
				startedAt: run.startedAt.toISOString(),
				completedAt: run.completedAt?.toISOString() ?? null,
			});
			recentRunsByWorkflow.set(run.workflowId, list);
		}

		const results = rows.map((row) => {
			const recentRuns = recentRunsByWorkflow.get(row.id) ?? [];
			const latest = recentRuns[0] ?? null;
			const updatedAt = row.updatedAt.toISOString();
			const running = latest?.status === "running" || latest?.status === "pending";
			const lastActivityAt =
				latest && latest.startedAt > updatedAt ? latest.startedAt : updatedAt;
			return {
				id: row.id,
				name: row.name,
				updatedAt,
				latestExecution: latest,
				recentRuns,
				running,
				lastActivityAt,
				forkCount: forkCountByWorkflow.get(row.id) ?? 0,
			};
		});

		results.sort((a, b) => {
			if (a.running !== b.running) return a.running ? -1 : 1;
			return b.lastActivityAt.localeCompare(a.lastActivityAt);
		});
		return results;
	}

	async listServiceGraphPickerOptions(input: {
		userId: string;
		projectId?: string | null;
		workflowLimit: number;
		executionLimit: number;
	}): Promise<ServiceGraphPickerOptions> {
		const [workflowRows, executionRows] = await Promise.all([
			this.deps.workflowDefinitions.listForWorkspace({
				limit: input.workflowLimit,
				userId: input.userId,
				projectId: input.projectId,
			}),
			this.deps.workflowExecutions.listRecentExecutionPickerRecords({
				limit: input.executionLimit,
				userId: input.userId,
				projectId: input.projectId,
			}),
		]);
		const workflowName = new Map(workflowRows.map((workflow) => [workflow.id, workflow.name]));
		const executions = executionRows.map((execution) => {
			const when = execution.startedAt.toISOString().slice(5, 16).replace("T", " ");
			const workflow =
				execution.workflowId && workflowName.has(execution.workflowId)
					? workflowName.get(execution.workflowId)
					: "workflow";
			return {
				id: execution.id,
				label: `${workflow} \u00b7 ${execution.status} \u00b7 ${when}`,
				workflowId: execution.workflowId,
			};
		});
		return {
			workflows: workflowRows.map((workflow) => ({
				id: workflow.id,
				name: workflow.name,
			})),
			executions,
			defaultExecutionId: executions[0]?.id ?? "",
		};
	}

	findProjectWorkflowIdByIdOrNamePrefix(input: {
		projectId: string;
		workflowId: string;
		namePrefix: string;
	}) {
		return this.deps.workflowDefinitions.findProjectWorkflowIdByIdOrNamePrefix(input);
	}

	async getPieceCatalogDetail(input: {
		pieceNameCandidates: string[];
		projectId: string;
	}): Promise<PieceCatalogDetail> {
		const [piece, usage] = await Promise.all([
			this.deps.pieceCatalog.getLatestPieceMetadata(input.pieceNameCandidates),
			this.deps.pieceCatalog.listConnectionUsageByPieceNames(input),
		]);
		const usageByConnection: PieceCatalogDetail["usageByConnection"] = {};
		for (const row of usage) {
			usageByConnection[row.connectionExternalId] = {
				refCount: row.refCount,
				workflowCount: row.workflowCount,
			};
		}
		return { piece, usageByConnection };
	}

	async getPieceConnectionDetailPage(input: {
		pieceName: string;
		projectId: string;
	}) {
		const pieceName = normalizeMcpPieceName(input.pieceName);
		if (!pieceName) return null;

		const { piece, usageByConnection } = await this.getPieceCatalogDetail({
			pieceNameCandidates: mcpPieceCandidates(pieceName),
			projectId: input.projectId,
		});
		if (!piece) return null;

		const authType = mcpPieceAuthType(piece.auth);
		return {
			piece: {
				pieceName,
				canonicalPieceName: `@activepieces/piece-${pieceName}`,
				displayName: piece.displayName,
				description: piece.description,
				logoUrl: piece.logoUrl,
				categories: piece.categories ?? [],
				version: piece.version,
				authType,
				authDisplayName: mcpPieceAuthDisplayName(piece.auth),
				requiresAuth: mcpPieceRequiresAuth(authType),
				isOAuth2: isOAuth2AuthType(authType),
				availableOnly: piece.availableOnly === true,
				catalogSourceImage: piece.catalogSourceImage,
				catalogSyncedAt: piece.catalogSyncedAt?.toISOString() ?? null,
				metadataUpdatedAt: piece.updatedAt?.toISOString() ?? null,
			},
			actions: pieceActionsFromMetadata(piece.actions),
			usageByConnection,
		};
	}

	async listConnectablePieces(input: { authOnly?: boolean }) {
		const pieces = await this.deps.pieceCatalog.listConnectablePieces({
			authOnly: input.authOnly === true,
		});
		return pieces.map((piece) => ({
			name: `@activepieces/piece-${piece.name}`,
			displayName: piece.displayName,
			logoUrl: piece.logoUrl,
			authType: piece.authType,
		}));
	}

	async listCatalogFunctions(input: { userId?: string | null }) {
		let apFunctions: CatalogFunctionSummary[] = [];
		let apError: string | null = null;
		try {
			apFunctions = await this.deps.pieceCatalog.listPieceCatalogFunctions();
		} catch (err) {
			apError = String(err);
		}

		const codeFunctions =
			input.userId && this.deps.codeFunctionCatalog
				? (await this.deps.codeFunctionCatalog.listEnabledForCatalog(input.userId)).map(
						toCodeCatalogFunction,
					)
				: [];
		const functions = [...codeFunctions, ...apFunctions];
		return {
			functions,
			count: functions.length,
			error: apError,
		};
	}

	async getBenchmarkBrowserReadModel(input: {
		projectId: string | null;
	}): Promise<BenchmarkBrowserReadModel> {
		await this.deps.benchmarkBrowser.ensureDefaultSuites();
		const [
			instanceRows,
			repoFacetRows,
			suiteRows,
			agentRows,
			environmentBuildRows,
		] = await Promise.all([
			this.deps.benchmarkBrowser.listInstances(),
			this.deps.benchmarkBrowser.listRepoFacets(),
			this.deps.benchmarkBrowser.listSuites(),
			this.deps.benchmarkBrowser.listRunnableAgentCandidates(input),
			this.deps.benchmarkBrowser.listEnvironmentBuilds(),
		]);

		const staticEnvironmentMappings = loadSwebenchInferenceEnvironmentMappings();
		const buildStatusByHash = new Map<
			string,
			{
				status: BenchmarkInstanceEnvironmentStatus;
				environmentKey: string | null;
			}
		>();
		for (const build of environmentBuildRows) {
			const hash = build.envSpecHash?.trim();
			if (!hash) continue;
			const status = classifyEnvironmentBuild(build);
			const existing = buildStatusByHash.get(hash);
			if (
				existing &&
				ENVIRONMENT_STATUS_RANK[existing.status] >=
					ENVIRONMENT_STATUS_RANK[status]
			) {
				continue;
			}
			buildStatusByHash.set(hash, {
				status,
				environmentKey: build.environmentKey ?? null,
			});
		}

		const instances: BenchmarkInstanceRow[] = instanceRows.map((row) => {
			const md = row.testMetadata ?? {};
			const versionField = metadataString(md, ["version"]);
			const dynamicEnvironmentSpecHash =
				row.repo && row.baseCommit
					? buildSwebenchEnvironmentSpec({
							dataset: row.datasetName,
							suiteSlug: normalizeSwebenchSuiteSlug(row.suiteSlug),
							instanceId: row.instanceId,
							repo: row.repo,
							baseCommit: row.baseCommit,
							testMetadata: md,
						}).envSpecHash
					: null;
			const staticEnvironment = resolveSwebenchInferenceEnvironment(
				{
					suiteSlug: row.suiteSlug,
					repo: row.repo,
					baseCommit: row.baseCommit,
					testMetadata: md,
				},
				dynamicEnvironmentSpecHash ?? "",
				{ mappings: staticEnvironmentMappings },
			);
			const exactStaticEnvironment = isExactValidatedSwebenchInferenceEnvironment(
				{
					suiteSlug: row.suiteSlug,
					repo: row.repo,
					baseCommit: row.baseCommit,
					testMetadata: md,
				},
				dynamicEnvironmentSpecHash ?? "",
				{ mappings: staticEnvironmentMappings },
			);
			const buildStatus = dynamicEnvironmentSpecHash
				? buildStatusByHash.get(dynamicEnvironmentSpecHash)
				: null;
			const environmentStatus: BenchmarkInstanceEnvironmentStatus =
				exactStaticEnvironment
					? "validated"
					: (buildStatus?.status ?? "not_built");
			const environmentKey =
				exactStaticEnvironment
					? (staticEnvironment.environmentKey ?? null)
					: (buildStatus?.environmentKey ?? null);
			const hintsLen = row.hintsText ? row.hintsText.length : 0;
			return {
				id: row.id,
				instanceId: row.instanceId,
				suiteSlug: row.suiteSlug,
				suiteName: row.suiteName,
				repo: row.repo,
				baseCommit: row.baseCommit ? row.baseCommit.slice(0, 12) : null,
				version: versionField,
				environmentStatus,
				environmentKey,
				problemPreview: trimProblem(row.problemStatement),
				hasHints: hintsLen > 0,
				hintsLen,
			};
		});

		const repoFacets = repoFacetRows
			.filter((r): r is { repo: string; count: number } => Boolean(r.repo))
			.map((r) => ({
				value: r.repo,
				label: r.repo,
				count: Number(r.count),
			}))
			.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

		const suiteCounts = new Map<string, number>();
		const suiteEnvironmentCoverage = new Map<
			string,
			{ validated: number; building: number; failed: number; notBuilt: number }
		>();
		for (const instance of instances) {
			suiteCounts.set(
				instance.suiteSlug,
				(suiteCounts.get(instance.suiteSlug) ?? 0) + 1,
			);
			const coverage =
				suiteEnvironmentCoverage.get(instance.suiteSlug) ??
				{ validated: 0, building: 0, failed: 0, notBuilt: 0 };
			if (instance.environmentStatus === "validated") coverage.validated += 1;
			else if (instance.environmentStatus === "building") coverage.building += 1;
			else if (instance.environmentStatus === "failed") coverage.failed += 1;
			else coverage.notBuilt += 1;
			suiteEnvironmentCoverage.set(instance.suiteSlug, coverage);
		}
		const suiteFacets = suiteRows.map((suite) => ({
			slug: suite.slug,
			name: suite.name,
			instanceCount: suiteCounts.get(suite.slug) ?? 0,
			environmentCoverage: suiteEnvironmentCoverage.get(suite.slug) ?? {
				validated: 0,
				building: 0,
				failed: 0,
				notBuilt: 0,
			},
		}));

		const runnableAgents = agentRows
			.filter(
				(row): row is typeof row & { versionNumber: number } =>
					row.currentVersionId != null && row.versionNumber != null,
			)
			.filter((row) => {
				const cfg = row.config ?? {};
				const modelSpec =
					typeof cfg.modelSpec === "string" ? cfg.modelSpec : null;
				const option = agentModelOptionFor(modelSpec);
				return Boolean(
					option &&
						option.sweBenchCapable !== false &&
						TOOL_CAPABLE_BENCHMARK_PROVIDERS.has(option.provider) &&
						benchmarkRuntimeSupportsProvider(row.runtime, option.provider),
				);
			})
			.map((row) => {
				const cfg = row.config ?? {};
				const modelSpec =
					typeof cfg.modelSpec === "string" ? cfg.modelSpec : null;
				const runtimeRoute = resolveAgentRuntimeRoute({
					agentSlug: row.slug,
					runtimeAppId: row.runtimeAppId,
					config: cfg as AgentConfig,
				});
				const capacity = estimateBenchmarkRuntimeCapacity({
					runtimeClass: runtimeRoute.runtimeClass,
					runtimeIsolation: runtimeRoute.isolation,
					runtimeAppId: runtimeRoute.appId,
					poolMaxReplicas: runtimeRoute.pool?.maxReplicas,
					slotsPerReplica: runtimeRoute.pool?.slotsPerReplica,
					maxActiveSessions: runtimeRoute.pool?.maxActiveSessions,
					requestedInstanceCount: 500,
					requestedConcurrency: 500,
					executionBackend: benchmarkExecutionBackend(),
				});
				return {
					id: row.id,
					slug: row.slug,
					name: row.name,
					avatar: row.avatar,
					runtime: row.runtime,
					currentVersion: row.versionNumber,
					registryStatus: row.registryStatus ?? "unregistered",
					modelSpec,
					benchmarkCapacity: {
						runtimeClass: capacity.runtimeClass,
						runtimeAppId: capacity.runtimeAppId,
						runtimeReplicas: capacity.runtimeReplicas,
						perSidecarWorkflowLimit: capacity.perSidecarWorkflowLimit,
						slotsPerReplica: capacity.slotsPerReplica,
						maxActiveSessions: capacity.maxActiveSessions,
						maxActiveSandboxes: capacity.maxActiveSandboxes,
					},
				};
			});

		return {
			instances,
			repoFacets,
			suiteFacets,
			runnableAgents,
			};
		}

	async getBenchmarkRunsPageReadModel(input: { projectId: string }) {
		const benchmarkRunReads = this.requireBenchmarkRunReads();
		const runs = await benchmarkRunReads.listRuns({
			projectId: input.projectId,
			limit: 100,
		});

		const suiteSet = new Map<
			string,
			{ slug: string; name: string; count: number }
		>();
		const agentSet = new Map<
			string,
			{ id: string; name: string; slug: string | null; count: number }
		>();
		const modelSet = new Map<string, number>();
		const tagSet = new Map<string, number>();
		for (const run of runs) {
			const suite = suiteSet.get(run.suiteSlug) ?? {
				slug: run.suiteSlug,
				name: run.suiteName,
				count: 0,
			};
			suite.count += 1;
			suiteSet.set(run.suiteSlug, suite);

			const agent = agentSet.get(run.agentName) ?? {
				id: run.agentName,
				name: run.agentName,
				slug: run.agentSlug,
				count: 0,
			};
			agent.count += 1;
			agentSet.set(run.agentName, agent);

			modelSet.set(
				run.modelNameOrPath,
				(modelSet.get(run.modelNameOrPath) ?? 0) + 1,
			);
			for (const tag of run.tags ?? []) {
				tagSet.set(tag, (tagSet.get(tag) ?? 0) + 1);
			}
		}

		return {
			runs,
			suiteOptions: [...suiteSet.values()].sort((a, b) => b.count - a.count),
			agentOptions: [...agentSet.values()].sort((a, b) => b.count - a.count),
			modelOptions: [...modelSet.entries()]
				.map(([model, count]) => ({ model, count }))
				.sort((a, b) => b.count - a.count),
			tagOptions: [...tagSet.entries()]
				.map(([tag, count]) => ({ tag, count }))
				.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)),
		};
	}

	async getBenchmarkComparePageReadModel(input: {
		projectId: string;
		runsParam?: string | null;
		tag?: string | null;
	}) {
		const benchmarkRunReads = this.requireBenchmarkRunReads();
		let runIds = (input.runsParam ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		const tag = input.tag?.trim() || null;
		const resolvedFromTag = tag;

		if (runIds.length === 0 && tag) {
			const tagged = await benchmarkRunReads.listRuns({
				projectId: input.projectId,
				limit: 100,
				tag,
			});
			runIds = tagged.slice(0, 4).map((run) => run.id);
		}

		if (runIds.length < 2) {
			return {
				compare: null,
				runIds,
				resolvedFromTag,
			};
		}

		const compare = await benchmarkRunReads.loadCompareData({
			projectId: input.projectId,
			runIds,
		});
		return { compare, runIds, resolvedFromTag };
	}

	async getObservabilityServiceGraphContext(input: {
		userId: string;
		projectId?: string | null;
		executionId?: string | null;
		workflowId?: string | null;
	}) {
		const caller = { userId: input.userId, projectId: input.projectId ?? null };
		let execution: WorkflowExecutionRecord | null = null;
		let workflow: ObservabilityServiceGraphWorkflowReadModel | null = null;

		if (input.executionId) {
			const row = await this.deps.workflowExecutions.getById(input.executionId);
			if (!this.isResourceVisibleToCaller(row, caller)) return null;
			execution = row;
			if (row.workflowId) {
				const definition = await this.deps.workflowDefinitions.getById(row.workflowId);
				if (this.isResourceVisibleToCaller(definition, caller)) {
					workflow = {
						id: definition.id,
						nodes: definition.nodes,
						edges: definition.edges,
					};
				}
			}
		}

		const targetWorkflowId = input.workflowId?.trim() || workflow?.id || null;
		if (!workflow && targetWorkflowId) {
			const definition = await this.deps.workflowDefinitions.getById(targetWorkflowId);
			if (!this.isResourceVisibleToCaller(definition, caller)) return null;
			workflow = {
				id: definition.id,
				nodes: definition.nodes,
				edges: definition.edges,
			};
		}

		return {
			execution,
			workflow,
			targetWorkflowId,
		};
	}

	resolveWorkflowActivityRateTarget(input: {
		executionId: string;
	}): Promise<WorkflowActivityRateTargetReadModel | null> {
		return this.requireActivityRateTargets().resolveWorkflowActivityRateTarget(input);
	}

	getObservabilityTraceScope(input: {
		userId: string;
		projectId?: string | null;
		sessionIdFilter?: string | null;
		sessionLimit?: number;
		executionLimit?: number;
	}): Promise<ObservabilityTraceScopeReadModel | null> {
		return this.requireObservabilityTraces().getTraceScope(input);
	}

	listObservabilityTraceGoalChips(input: {
		sessionIds: string[];
	}): Promise<ObservabilityTraceGoalChipReadModel[]> {
		return this.requireObservabilityTraces().listTraceGoalChips(input);
	}

	listWorkflowMonitorFallbackExecutions(input: {
		limit: number;
	}): Promise<WorkflowMonitorFallbackExecutionReadModel[]> {
		return this.requireWorkflowMonitorReads().listFallbackExecutions(input);
	}

	getPromptPresetUsages(input: {
		presetId: string;
		projectId: string;
	}) {
		return this.requireResourceUsages().getPromptPresetUsages(input);
	}

	listAgentSkillUsedBy(input: {
		skillRef: string;
		projectId?: string | null;
		limit: number;
	}) {
		return this.requireResourceUsages().listAgentSkillUsedBy(input);
	}

	getVaultUsages(input: { vaultId: string }) {
		return this.requireResourceUsages().getVaultUsages(input);
	}

	listAiAssistantMessages(input: {
		workflowId: string;
		userId: string;
		limit: number;
	}) {
		return this.requireAiAssistantMessages().listMessages(input);
	}

	deleteAiAssistantMessages(input: { workflowId: string; userId: string }) {
		return this.requireAiAssistantMessages().deleteMessages(input);
	}

	getSecurityAudit(input: { projectId?: string | null; now?: Date }) {
		const now = input.now ?? new Date();
		const since = new Date(now.getTime() - 30 * 86_400_000);
		return this.requireSecurityAudit().getSecurityAudit({
			projectId: input.projectId ?? null,
			since,
			now,
			limit: 100,
		});
	}

	getDashboard(input: { userId: string; now?: Date }) {
		return this.requireDashboard().getDashboard({
			userId: input.userId,
			now: input.now ?? new Date(),
		});
	}

	getBenchmarkInstanceDetail(input: { suiteSlug: string; instanceId: string }) {
		return this.requireBenchmarkInstanceDetails().getBenchmarkInstanceDetail(input);
	}

	listBenchmarkRunInstanceScores(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}) {
		return this.requireBenchmarkRunInstanceScores().listRunInstanceScores(input);
	}

	getBenchmarkRunInstanceDetail(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}) {
		return this.requireBenchmarkRunInstanceDetails().getRunInstanceDetail(input);
	}

	getBenchmarkRunInstanceAnnotations(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}) {
		return this.requireBenchmarkRunInstanceAnnotations().getRunInstanceAnnotations(input);
	}

	upsertBenchmarkRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
		verdict?: unknown;
		reasoning?: unknown;
	}) {
		const verdict =
			typeof input.verdict === "string" ? input.verdict.trim() : "";
		if (
			!BENCHMARK_INSTANCE_ANNOTATION_VERDICTS.includes(
				verdict as BenchmarkInstanceAnnotationVerdict,
			)
		) {
			return Promise.resolve({
				status: "invalid_verdict" as const,
				allowed: BENCHMARK_INSTANCE_ANNOTATION_VERDICTS,
			});
		}
		const reasoning =
			typeof input.reasoning === "string" ? input.reasoning.trim() || null : null;
		return this.requireBenchmarkRunInstanceAnnotations().upsertRunInstanceAnnotation({
			runId: input.runId,
			instanceId: input.instanceId,
			projectId: input.projectId,
			userId: input.userId,
			verdict: verdict as BenchmarkInstanceAnnotationVerdict,
			reasoning,
		});
	}

	deleteBenchmarkRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}) {
		return this.requireBenchmarkRunInstanceAnnotations().deleteRunInstanceAnnotation(input);
	}

	promoteBenchmarkRunInstanceToDataset(input: {
		projectId: string;
		datasetId: string;
		runId?: unknown;
		instanceId?: unknown;
		now?: Date;
	}) {
		const runId = typeof input.runId === "string" ? input.runId.trim() : "";
		const instanceId =
			typeof input.instanceId === "string" ? input.instanceId.trim() : "";
		if (!runId || !instanceId) {
			return Promise.resolve({
				status: "invalid_input" as const,
				message: "runId and instanceId are required",
			});
		}
		return this.requireBenchmarkDatasetPromotions().promoteRunInstanceToDataset({
			projectId: input.projectId,
			datasetId: input.datasetId,
			runId,
			instanceId,
			now: input.now ?? new Date(),
		});
	}

	getBenchmarkRunInstanceProgress(input: {
		runId: string;
		instanceId: string;
		now?: Date;
	}) {
		return this.requireBenchmarkRunInstanceProgress().getRunInstanceProgress({
			runId: input.runId,
			instanceId: input.instanceId,
			now: input.now ?? new Date(),
		});
	}

	recordBenchmarkArtifact(input: BenchmarkArtifactMetadataInput) {
		return this.requireBenchmarkArtifactMetadata().recordArtifact(input);
	}

	ingestBenchmarkEvaluationResults(
		input: BenchmarkEvaluationResultsCallbackInput,
	): Promise<BenchmarkEvaluationIngestResult> {
		const service = new ApplicationBenchmarkEvaluationResultsService({
			results: this.requireBenchmarkEvaluationResults(),
			lifecycle: this.requireBenchmarkRunLifecycle(),
			telemetry: this.requireBenchmarkEvaluationTelemetry(),
			events: this.requireBenchmarkEvaluationEvents(),
		});
		return service.ingest(input);
	}

	getBenchmarkRunProjectId(runId: string) {
		return this.requireBenchmarkRuns().getProjectId(runId);
	}

	async getDevPreviewHubReadModel(input: { projectId?: string | null }) {
		const devEnvironments = this.requireDevEnvironments();
		const projectId = input.projectId ?? null;
		const devWorkflowId = projectId
			? await this.findProjectWorkflowIdByIdOrNamePrefix({
					projectId,
					workflowId: DEV_SESSION_WORKFLOW_ID,
					namePrefix: "Microservice dev-session%",
				})
			: null;
		return {
			services: devEnvironments.listServices(),
			devWorkflowId,
			devWorkflowName: DEV_SESSION_WORKFLOW_ID,
		};
	}

	async listDevPreviewServices() {
		return this.requireDevEnvironments().listServices();
	}

	async listDevEnvironments(input: { projectId?: string | null }) {
		return this.requireDevEnvironments().listDevEnvironments(
			input.projectId ?? null,
		);
	}

	async getDevEnvironmentOrPending(input: {
		executionId: string;
		projectId?: string | null;
	}) {
		return this.requireDevEnvironments().getDevEnvironmentOrPending({
			executionId: input.executionId,
			projectId: input.projectId ?? null,
		});
	}

	createWorkflowDefinition(input: CreateWorkflowDefinitionInput) {
		return this.deps.workflowDefinitions.create(input);
	}

	updateWorkflowDefinition(id: string, input: UpdateWorkflowDefinitionInput) {
		return this.deps.workflowDefinitions.update(id, input);
	}

	hasActiveWorkflowExecutions(id: string) {
		return this.deps.workflowDefinitions.hasActiveExecutions(id);
	}

	deleteWorkflowDefinition(id: string) {
		return this.deps.workflowDefinitions.delete(id);
	}

	listWorkflowTriggers(workflowId: string) {
		return this.deps.workflowTriggers.listByWorkflowId(workflowId);
	}

	createWorkflowTrigger(input: CreateWorkflowTriggerInput) {
		return this.deps.workflowTriggers.create(input);
	}

	getWorkflowTrigger(input: { workflowId: string; triggerId: string }) {
		return this.deps.workflowTriggers.getForWorkflow(input);
	}

	getWorkflowTriggerById(triggerId: string) {
		return this.deps.workflowTriggers.getById(triggerId);
	}

	markWorkflowTriggerFired(input: { triggerId: string; firedAt?: Date }) {
		return this.deps.workflowTriggers.markFired({
			triggerId: input.triggerId,
			firedAt: input.firedAt ?? new Date(),
		});
	}

	deleteWorkflowTrigger(triggerId: string) {
		return this.deps.workflowTriggers.delete(triggerId);
	}

	getPieceExecutionByIdempotencyKey(
		idempotencyKey: string,
	): Promise<PieceExecutionReadModel | null> {
		if (!this.deps.pieceExecutions) {
			throw new Error("Piece execution repository is not configured");
		}
		return this.deps.pieceExecutions.getByIdempotencyKey(idempotencyKey);
	}

	async getSessionProvisioningReadModel(input: {
		sessionId: string;
		projectId?: string | null;
	}) {
		const context = await this.requireSessions().getSessionProvisioningContext(input);
		if (!context) return { status: "not_found" as const };
		if (
			context.status === "running" ||
			context.status === "idle" ||
			context.status === "terminated"
		) {
			return {
				status: "ok" as const,
				data: {
					phase: "running" as const,
					label: context.status === "terminated" ? "Ended" : "Sandbox ready",
					detail: null,
					podName: null,
					podPhase: null,
				},
			};
		}
		return {
			status: "ok" as const,
			data: await this.requireSessionProvisioning().getSessionProvisioning({
				sessionId: context.id,
				runtimeAppId: context.runtimeAppId,
			}),
		};
	}

	getSessionContextUsage(input: {
		sessionId: string;
		projectId?: string | null;
	}) {
		return this.requireSessions().getSessionContextUsage(input);
	}

	getSessionBrowserTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserTarget | null> {
		return this.requireSessions().getBrowserSessionTarget(input);
	}

	async getSessionRuntimeConfig(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return null;
		return this.requireSessionRuntimeConfigs().getSessionRuntimeConfig({
			sessionId: input.sessionId,
			projectId: input.projectId ?? session.projectId ?? null,
		});
	}

	saveWorkflowBrowserArtifact(
		input: SaveWorkflowBrowserArtifactInput,
	): Promise<WorkflowBrowserArtifactRecord> {
		if (!this.deps.browserArtifacts) {
			throw new Error("Workflow browser artifact store is not configured");
		}
		return this.deps.browserArtifacts.save(input);
	}

	listWorkflowBrowserArtifactsByExecutionId(
		workflowExecutionId: string,
	): Promise<WorkflowBrowserArtifactRecord[]> {
		if (!this.deps.browserArtifacts) {
			throw new Error("Workflow browser artifact store is not configured");
		}
		return this.deps.browserArtifacts.listByExecutionId(workflowExecutionId);
	}

	getWorkflowBrowserBlobPayload(
		storageRef: string,
	): Promise<WorkflowBrowserBlobPayload | null> {
		if (!this.deps.browserArtifacts) {
			throw new Error("Workflow browser artifact store is not configured");
		}
		return this.deps.browserArtifacts.getBlobPayload(storageRef);
	}

	async validateApiKeyForUser(input: {
		authorizationHeader: string | null;
		userId: string;
	}) {
		const authHeader = input.authorizationHeader;
		if (!authHeader) {
			return { valid: false as const, error: "Missing Authorization header", statusCode: 401 };
		}

		const key = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
		if (!key?.startsWith("wfb_")) {
			return { valid: false as const, error: "Invalid API key format", statusCode: 401 };
		}

		const keyHash = createHash("sha256").update(key).digest("hex");
		const apiKey = await this.deps.apiKeys.getByKeyHash(keyHash);
		if (!apiKey) {
			return { valid: false as const, error: "Invalid API key", statusCode: 401 };
		}
		if (apiKey.userId !== input.userId) {
			return {
				valid: false as const,
				error: "You do not have permission to run this workflow",
				statusCode: 403,
			};
		}

		void this.deps.apiKeys.markUsed(apiKey.id, new Date()).catch(() => {});
		return { valid: true as const, apiKeyId: apiKey.id };
	}

	listUserApiKeys(userId: string) {
		return this.deps.apiKeys.listByUserId(userId);
	}

	async createUserApiKey(input: { userId: string; name: string }) {
		const secret = createPlaintextWorkflowBuilderApiKey();
		const created = await this.deps.apiKeys.createUserApiKey({
			id: generateId(),
			userId: input.userId,
			name: input.name.trim(),
			keyHash: secret.keyHash,
			keyPrefix: secret.keyPrefix,
		});
		return {
			id: created.id,
			name: created.name,
			keyPrefix: created.keyPrefix,
			createdAt: created.createdAt,
			key: secret.plaintextKey,
		};
	}

	deleteUserApiKey(input: { userId: string; keyId: string }) {
		return this.deps.apiKeys.deleteForUser({
			id: input.keyId,
			userId: input.userId,
		});
	}

	async rotateUserApiKey(input: { userId: string; keyId: string }) {
		const secret = createPlaintextWorkflowBuilderApiKey();
		const rotated = await this.deps.apiKeys.updateSecretForUser({
			id: input.keyId,
			userId: input.userId,
			keyHash: secret.keyHash,
			keyPrefix: secret.keyPrefix,
		});
		return rotated
			? {
					id: rotated.id,
					name: rotated.name,
					keyPrefix: rotated.keyPrefix,
					createdAt: rotated.createdAt,
					key: secret.plaintextKey,
				}
			: null;
	}

	async listEnabledModelIds(): Promise<string[]> {
		return this.deps.modelCatalog?.listEnabledModelIds() ?? [];
	}

	assertExecutionReadModelReady() {
		return this.deps.workflowExecutions.assertReadModelReady();
	}

	getExecutionById(id: string) {
		return this.deps.workflowExecutions.getById(id);
	}

	async getScopedExecutionById(
		input: WorkflowExecutionScopeInput,
	): Promise<WorkflowExecutionRecord | null> {
		const execution = await this.deps.workflowExecutions.getById(input.executionId);
		return isScopedExecutionInScope(execution, input) ? execution : null;
	}

	getExecutionByDaprInstanceId(instanceId: string) {
		return this.deps.workflowExecutions.getByDaprInstanceId(instanceId);
	}

	getWorkflowExecutionSessionOwnerContext(executionId: string) {
		return this.deps.workflowExecutions.getSessionOwnerContext(executionId);
	}

	getRunningWorkflowExecution(workflowId: string) {
		return this.deps.workflowExecutions.getRunningByWorkflowId(workflowId);
	}

	async listCliWorkspaceCommandCandidates(input: {
		executionId: string;
		limit: number;
	}): Promise<CliWorkspaceCommandCandidate[]> {
		const rows = await this.requireSessions().listCliWorkspaceSessionCandidates(input);
		const candidates: CliWorkspaceCommandCandidate[] = [];
		for (const row of rows) {
			if (getRuntimeDescriptor(row.agentRuntime)?.family !== "interactive-cli") continue;
			const runtimeAppId = row.runtimeAppId?.trim() || "";
			const appId =
				runtimeAppId ||
				row.agentRuntimeAppId?.trim() ||
				agentRuntimeDedicatedAppId(row.agentSlug);
			candidates.push({
				sessionId: row.id,
				userId: row.userId,
				projectId: row.projectId,
				appId,
				invokeTarget: agentRuntimeInvokeTarget(appId),
				runtimeSandboxName: row.runtimeSandboxName ?? null,
				source: runtimeAppId ? "persisted" : "agent",
				agentSlug: row.agentSlug,
				agentRuntime: row.agentRuntime,
			});
		}
		return candidates;
	}

	getWorkflowEnsureSession(sessionId: string) {
		return this.requireSessions().getWorkflowEnsureSession(sessionId);
	}

	createWorkflowEnsureSession(input: CreateWorkflowEnsureSessionInput) {
		return this.requireSessions().createWorkflowEnsureSession(input);
	}

	updateWorkflowEnsureSessionRuntime(input: UpdateWorkflowEnsureSessionRuntimeInput) {
		return this.requireSessions().updateWorkflowEnsureSessionRuntime(input);
	}

	listTerminalWorkflowSessionRuntimeHosts(input: { workflowExecutionId: string }) {
		return this.requireSessions().listTerminalWorkflowSessionRuntimeHosts(input);
	}

	async checkBenchmarkSessionProvisioningGate(input: {
		runId: string;
		instanceId?: string | null;
	}): Promise<BenchmarkSessionProvisioningGateResult> {
		const row = await this.requireBenchmarkRuns().getSessionProvisioningGate(input);
		if (!row) {
			return { ok: false, status: 404, message: "Benchmark run not found" };
		}
		if (row.runStatus !== "queued" && row.runStatus !== "inferencing") {
			return {
				ok: false,
				status: 409,
				message: `Benchmark run ${input.runId} is ${row.runStatus}; refusing to provision session host`,
			};
		}
		if (
			input.instanceId &&
			row.instanceStatus &&
			row.instanceStatus !== "queued" &&
			row.instanceStatus !== "inferencing"
		) {
			return {
				ok: false,
				status: 409,
				message: `Benchmark instance ${input.instanceId} is ${row.instanceStatus}; refusing to provision session host`,
			};
		}
		if (
			input.instanceId &&
			row.inferenceStatus &&
			row.inferenceStatus !== "queued" &&
			row.inferenceStatus !== "inferencing"
		) {
			return {
				ok: false,
				status: 409,
				message: `Benchmark instance ${input.instanceId} inference is ${row.inferenceStatus}; refusing to provision session host`,
			};
		}
		const summary = isRecord(row.summary) ? row.summary : {};
		const execution = isRecord(summary.execution) ? summary.execution : {};
		const benchmarkExecutionClass =
			typeof execution.class === "string" && execution.class.trim()
				? execution.class.trim()
				: null;
		return { ok: true, benchmarkExecutionClass };
	}

	async ensurePeerSession(
		input: EnsurePeerSessionInput,
	): Promise<EnsurePeerSessionResult> {
		const sessions = this.requireSessions();
		const existing = await sessions.getPeerSession(input.sessionId);
		if (existing) return { ok: true, session: existing, reused: true };

		let userId = "";
		let projectId: string | null = null;
		if (input.parentSessionId) {
			const parentOwner = await sessions.getSessionFileOwner(input.parentSessionId);
			if (parentOwner) {
				userId = parentOwner.userId;
				projectId = parentOwner.projectId;
			}
		}
		if (!userId) {
			const peerOwner = await this
				.requirePeerAgentResolver()
				.resolvePeerAgentOwner(input.peerAgentId);
			if (!peerOwner) {
				return {
					ok: false,
					status: 404,
					message: `Peer agent ${input.peerAgentId} not found`,
				};
			}
			userId = peerOwner.userId ?? "";
			projectId = projectId ?? peerOwner.projectId;
		}
		if (!userId) {
			return {
				ok: false,
				status: 500,
				message: "could not resolve userId for peer session",
			};
		}

		const session = await sessions.createPeerSession({
			id: input.sessionId,
			agentId: input.peerAgentId,
			title: input.title ?? `Delegated: ${input.prompt.slice(0, 40)}`,
			userId,
			projectId,
			parentExecutionId: input.parentInstanceId ?? input.parentSessionId ?? null,
		});
		if (input.prompt.trim()) {
			await this.requireSessionEvents().appendSessionEvent(session.id, {
				type: "user.message",
				data: {
					type: "user.message",
					content: [{ type: "text", text: input.prompt }],
				},
				processedAt: null,
			});
		}

		return { ok: true, session, reused: false };
	}

	resolvePeerAgentDispatchContext(input: {
		agentId: string;
		agentVersion?: number | null;
		environmentId?: string | null;
		environmentVersion?: number | null;
	}): Promise<PeerAgentDispatchContext | null> {
		return this.requirePeerAgentResolver().resolvePeerAgentDispatchContext(input);
	}

	getWorkflowAgentRuntimeIdentity(
		agentId: string,
	): Promise<WorkflowAgentRuntimeIdentity | null> {
		return this.requireWorkflowAgentReads().getWorkflowAgentRuntimeIdentity(agentId);
	}

	resolvePublishedWorkflowAgentForEnsure(input: {
		agentId: string | null;
		agentVersion?: number | null;
		projectId?: string | null;
	}): Promise<WorkflowPublishedAgentResolutionResult | null> {
		return this.requireWorkflowAgentReads().resolvePublishedWorkflowAgentForEnsure(
			input,
		);
	}

	countActiveTriggeredWorkflowRuns(input: { statuses: WorkflowExecutionStatus[] }) {
		return this.deps.workflowExecutions.countActiveTriggeredRuns(input);
	}

	getExecutionLineage(executionId: string) {
		return this.deps.workflowExecutions.getLineage(executionId);
	}

	listWorkflowExecutions(input: {
		workflowId: string;
		limit: number;
		include?: "summary" | "full";
	}) {
		return this.deps.workflowExecutions.listByWorkflowId(input);
	}

	listWorkflowExecutionRunSummaries(input: {
		workflowId: string;
		limit: number;
	}) {
		return this.deps.workflowExecutions.listRunSummariesByWorkflowId(input);
	}

	listExecutionSessions(input: {
		executionId: string;
		projectId?: string | null;
		includeAncestors?: boolean;
	}) {
		return this.deps.workflowExecutions.listSessionsForExecutionLineage({
			executionId: input.executionId,
			projectId: input.projectId,
			maxAncestors: input.includeAncestors === false ? 0 : 20,
		});
	}

	listExecutionOutputFiles(executionId: string) {
		return this.deps.workflowExecutions.listOutputFilesByExecutionId(executionId);
	}

	aggregateExecutionUsageMetrics(input: {
		executionId: string;
		projectId?: string | null;
		includeAncestors?: boolean;
	}) {
		return this.deps.workflowExecutions.aggregateUsageMetricsForExecutionLineage({
			executionId: input.executionId,
			projectId: input.projectId,
			maxAncestors: input.includeAncestors === false ? 0 : 20,
		});
	}

	createWorkflowExecution(input: CreateWorkflowExecutionInput) {
		return this.deps.workflowExecutions.create(input);
	}

	async getLiveExecutionInstance(executionId: string) {
		const execution = await this.deps.workflowExecutions.getById(executionId);
		const instanceId = execution?.daprInstanceId?.trim();
		if (!execution || !instanceId) return null;
		const status = String(execution.status || "").trim().toLowerCase();
		if (["completed", "failed", "success", "error", "cancelled", "terminated"].includes(status)) {
			return null;
		}
		return { instanceId, status };
	}

	attachExecutionSchedulerInstance(input: {
		executionId: string;
		instanceId: string;
		workflowSessionId?: string | null;
		primaryTraceId?: string | null;
	}) {
		return this.deps.workflowExecutions.attachSchedulerInstance(input);
	}

	markExecutionStartFailed(input: { executionId: string; error: string }) {
		return this.deps.workflowExecutions.markStartFailed(input);
	}

	listStaleRunningExecutions(input: { olderThanMinutes: number }) {
		return this.deps.workflowExecutions.listStaleRunningExecutions(input);
	}

	updateExecutionReadModel(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	) {
		return this.deps.workflowExecutions.updateReadModel(executionId, patch);
	}

	appendExecutionLog(input: AppendWorkflowExecutionLogInput) {
		return this.deps.workflowExecutions.appendLog(input);
	}

	updateExecutionLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	) {
		return this.deps.workflowExecutions.updateLog(executionId, id, patch);
	}

	listExecutionLogs(executionId: string) {
		return this.deps.workflowExecutions.listLogsByExecutionId(executionId);
	}

	listExecutionSessionIds(executionId: string) {
		return this.deps.workflowExecutions.listSessionIdsByExecutionId(executionId);
	}

	listExecutionAgentEvents(executionId: string) {
		return this.deps.workflowExecutions.listAgentEventsByExecutionId(executionId);
	}

	listExecutionAgentEventsAfter(input: { executionId: string; afterEventId: number }) {
		return this.deps.workflowExecutions.listAgentEventsByExecutionIdAfter(input);
	}

	async getSessionEventStreamSnapshot(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		return this.getScopedSession(input);
	}

	getSessionDetail(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		return this.getScopedSession(input);
	}

	async getSessionGoalFlow(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
		agentDecisions?: Parameters<typeof buildGoalFlowFromRecords>[2];
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return { status: "not_found" as const };
		const goalFlow = this.requireGoalFlow();
		const goal = await goalFlow.getCurrentGoalForSessions([input.sessionId]);
		if (!goal) return { status: "ok" as const, goalFlow: null };
		const events = await goalFlow.listGoalFlowEvents({
			sessionId: goal.sessionId,
		});
		return {
			status: "ok" as const,
			goalFlow: buildGoalFlowFromRecords(
				goal,
				events,
				input.agentDecisions ?? [],
			),
		};
	}

	async listSessionResources(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return null;
		return this.requireSessions().listSessionResources(input.sessionId);
	}

	async addSessionResource(input: {
		sessionId: string;
		resource: AddSessionResourceInput;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return { status: "not_found" as const };
		const resource = await this.requireSessions().addSessionResource({
			sessionId: input.sessionId,
			resource: input.resource,
		});
		return { status: "created" as const, resource, session };
	}

	async removeSessionResource(input: {
		sessionId: string;
		resourceId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return false;
		return this.requireSessions().removeSessionResource({
			sessionId: input.sessionId,
			resourceId: input.resourceId,
		});
	}

	async updateSessionTitle(input: {
		sessionId: string;
		title: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return null;
		return this.requireSessions().updateSessionTitle({
			id: input.sessionId,
			title: input.title,
		});
	}

	async getSessionRuntimeDebugTarget(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return null;
		return this.requireSessions().getSessionRuntimeDebugTarget({
			sessionId: input.sessionId,
			projectId: input.projectId ?? session.projectId ?? null,
		});
	}

	async getSessionRuntimeCompute(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const target = await this.getSessionRuntimeDebugTarget(input);
		if (!target) return null;
		return this.requireSessionRuntimeStatus().getSessionRuntimeCompute(target);
	}

	async getSessionRuntimeFlags(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const target = await this.getSessionRuntimeDebugTarget(input);
		if (!target) return null;
		return this.requireSessionRuntimeStatus().getSessionRuntimeFlags(target);
	}

	async getNewSessionPageReadModel() {
		return {
			cliAuthByRuntime:
				await this.requireRuntimeRegistry().listSessionRuntimeCliAuth(),
		};
	}

	async getSessionControlSettings(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return null;
		const refs =
			await this.requireWorkflowAgentReads().resolveSessionControlSettingsReferences({
				agentId: session.agentId,
				agentVersion: session.agentVersion ?? null,
				environmentId: session.environmentId ?? null,
				environmentVersion: session.environmentVersion ?? null,
			});
		return {
			session,
			agent: refs.agent,
			environment: refs.environment,
		};
	}

	async archiveSession(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return false;
		return this.requireSessions().archiveSession(input.sessionId);
	}

	async deleteSession(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return false;
		return this.requireSessions().deleteSession(input.sessionId);
	}

	async raiseSessionAgentConfigPatch(input: {
		sessionId: string;
		patch: unknown;
		projectId?: string | null;
		userId?: string | null;
	}): Promise<SessionAgentConfigPatchResult> {
		const session = await this.getScopedSession(input);
		if (!session) {
			return { ok: false, status: 404, error: "Session not found" };
		}
		return this.requireSessionAgentConfigCommands().raiseSessionAgentConfigPatch({
			sessionId: input.sessionId,
			patch: input.patch,
		});
	}

	listSessionEvents(sessionId: string, input?: ListSessionEventsInput) {
		return this.requireSessionEvents().listSessionEvents(sessionId, input);
	}

	async getSessionEvent(input: {
		sessionId: string;
		eventId: string;
		projectId?: string | null;
		userId?: string | null;
	}) {
		const session = await this.getScopedSession(input);
		if (!session) return null;
		return this.requireSessionEvents().getSessionEvent({
			sessionId: input.sessionId,
			eventId: input.eventId,
		});
	}

	listenSessionEventNotifications(
		onNotification: (notification: WorkflowSessionEventNotification) => void,
	) {
		return this.deps.sessionEventNotifications.listenSessionEvents(onNotification);
	}

	findSessionIdByDaprInstanceId(instanceId: string) {
		return this.requireSessions().findSessionIdByDaprInstanceId(instanceId);
	}

	resolveSessionIdForProvisioningEvent(input: {
		runtimeAppId?: string | null;
		sessionId?: string | null;
	}) {
		return this.requireSessions().resolveSessionIdForProvisioningEvent(input);
	}

	getSessionFileOwner(sessionId: string) {
		return this.requireSessions().getSessionFileOwner(sessionId);
	}

	appendSessionEvent(sessionId: string, event: AppendSessionEventInput) {
		return this.requireSessionEvents().appendSessionEvent(sessionId, event);
	}

	async appendSessionUserEvents(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
		events: UserEvent[];
	}): Promise<
		| {
				status: "ok";
				events: Awaited<ReturnType<SessionEventLog["appendSessionEvent"]>>[];
		  }
		| { status: "not_found" }
	> {
		const session = await this.getSessionEventStreamSnapshot({
			sessionId: input.sessionId,
			projectId: input.projectId ?? null,
			userId: input.userId ?? null,
		});
		if (!session) return { status: "not_found" };

		const appended = [];
		for (const event of input.events) {
			appended.push(
				await this.requireSessionEvents().appendSessionEvent(input.sessionId, {
					type: event.type,
					data: event as unknown as Record<string, unknown>,
					processedAt: null,
				}),
			);
		}

		try {
			await this.requireSessionRuntimeEvents().raiseSessionUserEvents(
				input.sessionId,
				input.events,
			);
		} catch (err) {
			console.warn("[sessions] raiseSessionUserEvents failed:", err);
		}

		return { status: "ok", events: appended };
	}

	async forkSessionFromEvent(input: {
		sourceSessionId: string;
		fromSequence: number;
		title?: string | null;
		agentConfig?: AgentConfig | null;
		userId: string;
		projectId?: string | null;
	}): Promise<
		| {
				status: "created";
				sessionId: string;
				sourceSessionId: string;
				replayed: number;
		  }
		| { status: "not_found" }
		| { status: "bad_request"; message: string }
	> {
		const sessions = this.requireSessions();
		const owner = await sessions.getSessionFileOwner(input.sourceSessionId);
		if (!owner) return { status: "not_found" };
		if (input.projectId && owner.projectId !== input.projectId) {
			return { status: "not_found" };
		}
		if (!input.projectId && owner.userId !== input.userId) {
			return { status: "not_found" };
		}
		const source = await sessions.getSession(input.sourceSessionId);
		if (!source) return { status: "not_found" };

		let forkAgentId = source.agentId;
		let forkAgentVersion = source.agentVersion ?? undefined;

		if (input.agentConfig) {
			const experiments = this.requireSessionExperimentAgents();
			const baseAgent = await experiments.resolveSessionForkBaseAgent({
				agentId: source.agentId,
				agentVersion: source.agentVersion ?? undefined,
			});
			if (
				baseAgent &&
				!isAgentConfigEquivalent(baseAgent.config, input.agentConfig)
			) {
				try {
					const experiment = await experiments.findOrCreateSessionExperimentAgent({
						baseAgentId: baseAgent.id,
						baseAgentSlug: baseAgent.slug,
						baseAgentName: baseAgent.name,
						agentConfig: input.agentConfig,
						userId: input.userId,
						projectId: input.projectId ?? source.projectId ?? null,
					});
					forkAgentId = experiment.agentId;
					forkAgentVersion = experiment.agentVersion;
				} catch (err) {
					return {
						status: "bad_request",
						message:
							err instanceof Error
								? err.message
								: "Experiment agent create failed",
					};
				}
			}
		}

		const title =
			input.title && input.title.trim()
				? input.title.trim()
				: `Fork of ${source.title ?? source.id} @ seq ${input.fromSequence}`;
		const forked = await this.requireSessions().createSessionFork({
			agentId: forkAgentId,
			agentVersion: forkAgentVersion,
			environmentId: source.environmentId ?? null,
			environmentVersion: source.environmentVersion ?? null,
			vaultIds: source.vaultIds,
			title,
			userId: input.userId,
			projectId: input.projectId ?? source.projectId ?? null,
		});

		const rows = await this.requireSessionEvents().listSessionEvents(
			input.sourceSessionId,
			{ atOrBeforeSequence: input.fromSequence },
		);
		for (const row of rows) {
			await this.requireSessionEvents().appendSessionEvent(forked.id, {
				type: row.type,
				data: row.data,
				processedAt: row.processedAt ? new Date(row.processedAt) : null,
				sourceEventId: `fork:${row.id}`,
			});
		}

		return {
			status: "created",
			sessionId: forked.id,
			sourceSessionId: input.sourceSessionId,
			replayed: rows.length,
		};
	}

	async ingestSessionEvent(input: IngestSessionEventInput): Promise<IngestSessionEventResult> {
		const sessions = this.requireSessions();
		const eventLog = this.requireSessionEvents();
		const envelope = await eventLog.appendSessionEvent(input.sessionId, {
			type: input.type,
			data: input.data,
			processedAt: input.processedAt,
			sourceEventId: input.sourceEventId,
			producerId: input.producerId,
			producerEpoch: input.producerEpoch,
		});

		let cleanupSessionSandbox = false;
		if (input.type === "session.status_starting" || input.type === "session.status_running") {
			await sessions.updateSessionStatusUnlessTerminated({
				id: input.sessionId,
				status: "running",
			});
		} else if (input.type === "session.status_idle") {
			await sessions.updateSessionStatusUnlessTerminated({
				id: input.sessionId,
				status: "idle",
				stopReason: normalizeSessionStopReason(input.data?.stop_reason),
			});
			void this.deps.sessionTraceLifecycle?.patchInteractiveSessionTraces({
				sessionId: input.sessionId,
				status: "OK",
			});
		} else if (input.type === "session.status_terminated") {
			await sessions.updateSessionStatus({
				id: input.sessionId,
				status: "terminated",
				stopReason: normalizeSessionStopReason(input.data?.stop_reason),
				markCompleted: true,
			});
			void this.deps.sessionTraceLifecycle?.patchInteractiveSessionTraces({
				sessionId: input.sessionId,
				status: "OK",
			});
			cleanupSessionSandbox = true;
		} else if (input.type === "session.status_rescheduled") {
			await sessions.updateSessionStatusUnlessTerminated({
				id: input.sessionId,
				status: "rescheduling",
			});
		}

		if (isRecord(input.data) && isRecord(input.data.codeCheckpoint)) {
			try {
				const sessionContext = await sessions.getSessionWorkflowContext(input.sessionId);
				const workflowExecutionId = sessionContext?.workflowExecutionId ?? null;
				if (workflowExecutionId) {
					const eventId = input.sourceEventId ?? envelope.id;
					const parentExecutionId = sessionContext?.parentExecutionId ?? null;
					const daprInstanceId = sessionContext?.daprInstanceId ?? input.sessionId;
					await this.requireCodeCheckpoints().persistFromAgentEvent({
						workflowExecutionId,
						workflowAgentRunId: null,
						parentExecutionId,
						daprInstanceId,
						sourceEventId: eventId,
						toolName:
							stringOrNull(input.data.tool_name) ??
							stringOrNull(input.data.toolName) ??
							input.type,
						nodeId: null,
						payload: input.data.codeCheckpoint,
					});
					const checkpointWarning = checkpointRemoteWarning(input.data.codeCheckpoint);
					if (checkpointWarning) {
						await this.requireEvaluationArtifacts().recordCodeCheckpointWarning({
							workflowExecutionId,
							sourceEventId: eventId,
							checkpoint: checkpointWarning,
						});
					}
				}
			} catch (err) {
				console.warn("[session-ingest] code checkpoint persist failed:", err);
			}
		}

		return { event: envelope, cleanupSessionSandbox };
	}

	upsertWorkflowArtifact(input: WorkflowArtifactInput) {
		return this.deps.artifactStore.upsertWorkflowArtifact(input);
	}

	listWorkflowArtifactsByExecutionId(executionId: string) {
		return this.deps.artifactStore.listWorkflowArtifactsByExecutionId(executionId);
	}

	listSourceBundleArtifactsByWorkflowId(workflowId: string) {
		return this.deps.artifactStore.listSourceBundleArtifactsByWorkflowId(workflowId);
	}

	getWorkflowArtifactForExecution(input: { executionId: string; artifactId: string }) {
		return this.deps.artifactStore.getWorkflowArtifactForExecution(input);
	}

	updateWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		metadata: Record<string, unknown> | null;
	}) {
		return this.deps.artifactStore.updateWorkflowArtifactMetadata(input);
	}

	createWorkflowFile(input: CreateWorkflowFileInput) {
		return this.requireWorkflowFiles().createFile(input);
	}

	getWorkflowFileContent(id: string) {
		return this.requireWorkflowFiles().getFileContent(id);
	}

	persistRunDiffArtifact(input: PersistWorkflowRunDiffInput) {
		const workflowFiles = this.requireWorkflowFiles();
		return persistRunDiff(input, {
			createFile: workflowFiles.createFile.bind(workflowFiles),
			getFileContent: workflowFiles.getFileContent.bind(workflowFiles),
			upsertWorkflowArtifact: this.deps.artifactStore.upsertWorkflowArtifact.bind(
				this.deps.artifactStore,
			),
		});
	}

	persistSourceBundleArtifact(input: PersistWorkflowSourceBundleInput) {
		const workflowFiles = this.requireWorkflowFiles();
		return persistSourceBundle(input, {
			createFile: workflowFiles.createFile.bind(workflowFiles),
			upsertWorkflowArtifact: this.deps.artifactStore.upsertWorkflowArtifact.bind(
				this.deps.artifactStore,
			),
		});
	}

	upsertWorkflowWorkspaceSession(input: UpsertWorkspaceSessionInput) {
		return this.deps.workspaceSessions.upsertWorkflowWorkspaceSession(input);
	}

	upsertScheduledAgentRun(input: UpsertWorkflowAgentRunScheduledInput) {
		return this.deps.agentRuns.upsertScheduledAgentRun(input);
	}

	updateAgentRunLifecycle(input: UpdateWorkflowAgentRunLifecycleInput) {
		return this.deps.agentRuns.updateAgentRunLifecycle(input);
	}

	upsertPlanArtifact(input: WorkflowPlanArtifactInput) {
		return this.deps.planArtifacts.upsertPlanArtifact(input);
	}

	listPlanArtifactsByExecutionId(executionId: string) {
		return this.deps.planArtifacts.listPlanArtifactsByExecutionId(executionId);
	}

	updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: WorkflowPlanArtifactStatus;
		metadata?: Record<string, unknown> | null;
	}) {
		return this.deps.planArtifacts.updatePlanArtifactStatus(input);
	}

	getPlanArtifact(artifactRef: string) {
		return this.deps.planArtifacts.getPlanArtifact(artifactRef);
	}

	getTraceTargetsForExecution(executionId: string) {
		return this.deps.traceLineage.getTraceTargetsForExecution(executionId);
	}

	upsertTraceLineageLinks(input: UpsertTraceLineageLinksInput) {
		return this.deps.traceLineage.upsertTraceLineageLinks(input);
	}

	async resolveMcpConfig(input: {
		workflowId?: string | null;
		projectId?: string | null;
		requestedServers?: unknown[];
		includeProjectConnections?: boolean;
	}) {
		let projectId = input.projectId?.trim() || null;
		const workflowId = input.workflowId?.trim();
		if (!projectId && workflowId) {
			const workflow = await this.deps.workflowDefinitions.getById(workflowId);
			projectId = workflow?.projectId ?? null;
		}

		const requestedServers = Array.isArray(input.requestedServers)
			? (input.requestedServers as McpServerProfileConfig[])
			: [];
		const rows = projectId
			? (await this.deps.mcpConnections.listProjectConnections(projectId)).filter(
					(row) => row.status === "ENABLED",
				)
			: [];
		let hostedToken: string | null = null;
		if (projectId && rows.some((row) => row.sourceType === "hosted_workflow")) {
			try {
				const hostedServer = await this.getOrCreateHostedMcpServer(projectId);
				hostedToken = decryptString(hostedServer.tokenEncrypted);
			} catch {
				hostedToken = null;
			}
		}

		const result = resolveMcpServerConfigsFromRows({
			rows,
			requestedServers,
			includeProjectConnections: input.includeProjectConnections,
			hostedToken,
		});
		return { projectId, ...result };
	}
}
