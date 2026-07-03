import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import {
	and,
	asc,
	count,
	desc,
	eq,
	gte,
	gt,
	inArray,
	isNotNull,
	isNull,
	like,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { db as defaultDb, sql as defaultSql } from "$lib/server/db";
import { BENCHMARK_AGENT_RUNTIMES } from "$lib/benchmarks/agent-runtimes";
import { pieceCatalogFunctionsFromRows } from "$lib/server/action-catalog/piece-metadata-source";
import { connectionBelongsToProject } from "$lib/server/app-connection-scope";
import { SWEBENCH_SUITES } from "$lib/server/benchmarks/swebench";
import { generateId } from "$lib/server/utils/id";
import {
	AppConnectionScope,
	AppConnectionStatus,
	AppConnectionType,
} from "$lib/server/types/app-connection";
import {
	files,
	filePayloads,
	apiKeys,
	appConnections,
	agentSkillRegistry,
	codeFunctions,
	credentialAccessLogs,
	environments,
	environmentVersions,
	mlflowLineageLinks,
	modelCatalog,
	agents,
	agentVersions,
	benchmarkArtifacts,
	benchmarkInstances,
	benchmarkRunInstances,
	benchmarkRunInstanceAnnotations,
	benchmarkRunInstanceScores,
	benchmarkRuns,
	benchmarkSuites,
	environmentImageBuilds,
	evaluationArtifacts,
	evaluationDatasets,
	evaluationDatasetRows,
	evaluationRunItems,
	projects,
	projectMembers,
	pieceExecution,
	pieceMetadata,
	pieceImages,
	platformOauthApps,
	platforms,
	platformDisabledPieces,
	mcpConnections,
	mcpServers,
	mcpRuns,
	sessionEvents,
	sessions,
	resourcePromptVersions,
	resourcePrompts,
	runtimeConfigAuditLogs,
	threadGoals,
	workflowAiMessages,
	workflowConnectionRefs,
	workflowArtifacts,
	workflowBrowserArtifacts,
	workflowBrowserArtifactBlobPayloads,
	workflowAgentRuns,
	workflowCodeCheckpoints,
	workflowExecutionLogs,
	workflowExecutions,
	workflowPlanArtifacts,
	workflowTriggers,
	workflowWorkspaceSessions,
	workflows,
	vaults,
	users,
	type Workflow,
	type WorkflowArtifactRow,
	type WorkflowCodeCheckpointStatus,
	type EvaluationArtifactKind,
	type WorkflowExecution,
	type WorkflowExecutionLog,
	type WorkflowPlanArtifact,
	type ThreadGoalRow,
} from "$lib/server/db/schema";
import type {
	AppendWorkflowExecutionLogInput,
	AdminPieceRepository,
	AgentRuntimeAgentRecord,
	AgentRuntimeRepository,
	AppConnectionCreatedRecord,
	AppConnectionOAuthCompletedRecord,
	AppConnectionOAuthPieceMetadataRecord,
	AppConnectionPlatformOAuthAppRecord,
	AppConnectionRecord,
	AppConnectionRepository,
	AppConnectionSecretRecord,
	AppConnectionSummaryRecord,
	AppConnectionUpdatedRecord,
	ApiKeyRecord,
	ApiKeyStore,
	ArtifactStore,
	BenchmarkArtifactMetadataInput,
	BenchmarkArtifactMetadataRepository,
	BenchmarkDatasetPromotionRepository,
	BenchmarkEvaluationPatchContext,
	BenchmarkEvaluationResultRepository,
	BenchmarkEvaluationResultUpdate,
	BenchmarkEvaluationRunRecord,
	BenchmarkInstanceAnnotationVerdict,
	BenchmarkBrowserRepository,
	BenchmarkInstanceDetailReadRepository,
	BenchmarkRunInstanceAnnotationCounts,
	BenchmarkRunInstanceAnnotationRepository,
	BenchmarkRunInstanceDetailReadRepository,
	BenchmarkRunInstanceProgressReadRepository,
	BenchmarkRunInstanceScoreReadRepository,
	BenchmarkRunRepository,
	BenchmarkSessionProvisioningGateRecord,
	SandboxExecutionRecord,
	SandboxInventoryRepository,
	CatalogFunctionSummary,
	CodeCatalogFunctionRecord,
	CodeFunctionCatalogRepository,
	ConnectablePieceRecord,
	CreateWorkspaceProjectInput,
	CreateWorkflowDefinitionInput,
	CreateWorkflowTriggerInput,
	CreateWorkflowExecutionInput,
	DashboardReadRepository,
	EvaluationArtifactStore,
	ExecutionWorkspaceRouteInfo,
	GoalFlowEventRecord,
	GoalFlowGoalRecord,
	GoalFlowReadStore,
	TraceLinkTarget,
	TraceLineageStore,
	PersistCodeCheckpointInput,
	UpsertTraceLineageLinksInput,
	UpdateWorkflowDefinitionInput,
	UpdateWorkflowAgentRunLifecycleInput,
	UpsertWorkflowAgentRunScheduledInput,
	WorkflowCodeCheckpointStore,
	WorkflowCodeCheckpointReadModel,
	WorkflowArtifactRecord,
	WorkflowArtifactInput,
	CreateWorkflowFileInput,
	WorkflowFileRecord,
	WorkflowFileStore,
	WorkflowAgentRunStore,
	UsageAnalyticsSnapshot,
	UsageCostRow,
	UsageReportingRepository,
	UsageReportingScope,
	LiveLimitSnapshot,
	CreateMcpConnectionRecordInput,
	HostedMcpServerRecord,
	HostedMcpServerRepository,
	HostedMcpWorkflowSourceRecord,
	HomePageReadRepository,
	ListWorkflowFilesFilter,
	McpConnectionRecord,
	McpConnectionRepository,
	McpRunRecord,
	McpRunRepository,
	ModelCatalogRepository,
	McpCatalogAppConnectionSummary,
	PieceExecutionReadModel,
	PieceExecutionRepository,
	ResourceUsageReadRepository,
	SecurityAuditReadRepository,
	ProjectMemberListItem,
	ProjectMemberRecord,
	ProjectMembershipRole,
	ObservabilityTraceGoalChipReadModel,
	ObservabilityTraceGoalVerdict,
	ObservabilityTraceRepository,
	ObservabilityTraceScopeReadModel,
	PieceCatalogRepository,
	SettingsRepository,
	UserProfileRecord,
	UserProfileRepository,
	WorkspaceProjectRepository,
	WorkflowAiAssistantMessageRepository,
	WorkflowDefinition,
	WorkflowDefinitionListItem,
	WorkflowDefinitionRepository,
	WorkflowTriggerRecord,
	WorkflowTriggerStore,
	WorkflowMonitorFallbackExecutionReadModel,
	WorkflowMonitorReadRepository,
	WorkflowActivityRateTargetReadModel,
	WorkflowActivityRateTargetRepository,
	WorkflowExecutionRecord,
	ActiveWorkflowExecutionReadModel,
	InternalAgentWorkflowExecutionListInput,
	InternalAgentWorkflowExecutionListReadModel,
	WorkflowExecutionForkCountRecord,
	WorkflowExecutionLogPatch,
	WorkflowExecutionPickerRecord,
	WorkflowExecutionReadModelPatch,
	WorkflowExecutionRecentRunRecord,
	WorkflowExecutionRepository,
	WorkflowExecutionSessionOwnerContext,
	WorkflowExecutionStatus,
	WorkflowExecutionLineage,
	WorkflowExecutionListItem,
	WorkflowExecutionRunSummary,
	WorkflowExecutionSessionSummary,
	WorkflowExecutionOutputFiles,
	WorkflowExecutionUsageMetricsRow,
	WorkflowExecutionLogRecord,
	WorkflowSessionEventNotificationSource,
	SaveWorkflowBrowserArtifactInput,
	WorkflowBrowserArtifactAssetInput,
	WorkflowBrowserArtifactRecord,
	WorkflowBrowserArtifactStore,
	WorkflowBrowserCaptureStepInput,
	WorkflowPlanArtifactInput,
	WorkflowPlanArtifactRecord,
	WorkflowPlanArtifactStore,
	UpsertWorkspaceSessionInput,
	WorkspaceProjectMembershipRecord,
	WorkspaceSessionStore,
} from "$lib/server/application/ports";

type Database = typeof defaultDb;
type PostgresSqlClient = typeof defaultSql;

export class PostgresAgentRuntimeRepository implements AgentRuntimeRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listProjectAgents(projectId: string): Promise<AgentRuntimeAgentRecord[]> {
		const rows = await this.database
			.select({
				id: agents.id,
				projectId: agents.projectId,
				slug: agents.slug,
				runtimeAppId: agents.runtimeAppId,
				isArchived: agents.isArchived,
			})
			.from(agents)
			.where(eq(agents.projectId, projectId));
		return rows;
	}

	async getAgentBySlug(input: {
		slug: string;
		projectId?: string | null;
	}): Promise<AgentRuntimeAgentRecord | null> {
		const [row] = await this.database
			.select({
				id: agents.id,
				projectId: agents.projectId,
				slug: agents.slug,
				runtimeAppId: agents.runtimeAppId,
				isArchived: agents.isArchived,
			})
			.from(agents)
			.where(
				and(
					eq(agents.slug, input.slug),
					input.projectId ? eq(agents.projectId, input.projectId) : undefined,
				),
			)
			.limit(1);
		return row ?? null;
	}

	async listRecentlyActiveAgentSlugs(input: {
		slugs: string[];
		activeStatuses: string[];
		updatedAfter: Date;
	}): Promise<string[]> {
		if (input.slugs.length === 0) return [];
		const rows = await this.database
			.select({ slug: agents.slug })
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.where(
				and(
					inArray(agents.slug, input.slugs),
					isNull(sessions.archivedAt),
					or(
						inArray(sessions.status, input.activeStatuses),
						gt(sessions.updatedAt, input.updatedAfter),
					),
				),
			);
		return [...new Set(rows.map((row) => row.slug))];
	}
}

const SLOT_RANK = sql<number>`CASE ${workflowArtifacts.slot}
	WHEN 'primary' THEN 0
	WHEN 'secondary' THEN 1
	WHEN 'aux' THEN 2
	ELSE 3
END`;
const SOURCE_BUNDLE_KIND = "source-bundle";

const EXECUTION_READ_MODEL_COLUMNS = [
	"current_node_id",
	"current_node_name",
	"primary_trace_id",
	"workflow_session_id",
	"summary_output",
] as const;

const EXECUTION_READ_MODEL_MIGRATIONS = [
	"atlas/migrations/20260408120000_add_execution_read_model_columns.sql",
	"drizzle/0024_execution_read_model.sql",
] as const;
const MAX_WORKFLOW_FILE_BYTES = 25 * 1024 * 1024;

export function requirePostgresDb(database: Database = defaultDb): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

function requirePostgresSql(sqlClient: PostgresSqlClient = defaultSql): PostgresSqlClient {
	if (!sqlClient) throw new Error("Database not configured");
	return sqlClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyBenchmarkAnnotationCounts(): BenchmarkRunInstanceAnnotationCounts {
	return {
		correct: 0,
		incorrect: 0,
		partial: 0,
		unsure: 0,
	};
}

function isBenchmarkAnnotationVerdict(
	value: unknown,
): value is BenchmarkInstanceAnnotationVerdict {
	return (
		value === "correct" ||
		value === "incorrect" ||
		value === "partial" ||
		value === "unsure"
	);
}

function parseSessionEventNotification(payload: string): { sessionId: string | null } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return { sessionId: null };
	}
	if (!parsed || typeof parsed !== "object" || !("sessionId" in parsed)) {
		return { sessionId: null };
	}
	const sessionId = (parsed as { sessionId?: unknown }).sessionId;
	return { sessionId: typeof sessionId === "string" && sessionId ? sessionId : null };
}

export class PostgresWorkflowSessionEventNotificationSource
	implements WorkflowSessionEventNotificationSource
{
	constructor(private readonly sqlClient: PostgresSqlClient = requirePostgresSql()) {}

	async listenSessionEvents(
		onNotification: (notification: { sessionId: string | null }) => void,
	) {
		const listener = await this.sqlClient.listen("session_events", (payload) => {
			onNotification(parseSessionEventNotification(payload));
		});
		return {
			unlisten: () => listener.unlisten(),
		};
	}
}

const GOAL_FLOW_EVENT_TYPES = [
	"user.message",
	"session.goal_rejected",
	"session.goal_completed",
	"session.status_idle",
	"agent.message",
	"agent.tool_use",
	"mcp.tool_call",
	"agent.llm_usage",
] as const;

function toGoalFlowGoalRecord(row: ThreadGoalRow): GoalFlowGoalRecord {
	return {
		sessionId: row.sessionId,
		goalId: row.goalId,
		objective: row.objective,
		status: row.status,
		iterations: row.iterations,
		maxIterations: row.maxIterations,
		tokensUsed: row.tokensUsed,
		tokenBudget: row.tokenBudget,
		stopReason: row.stopReason,
		acceptanceCriteria: row.acceptanceCriteria,
		evidencePlan: row.evidencePlan,
		createdAt: row.createdAt,
		completedAt: row.completedAt,
	};
}

export class PostgresGoalFlowReadStore implements GoalFlowReadStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getCurrentGoalForSessions(
		sessionIds: string[],
	): Promise<GoalFlowGoalRecord | null> {
		const ids = [...new Set(sessionIds.filter(Boolean))];
		if (ids.length === 0) return null;
		const [row] = await this.database
			.select()
			.from(threadGoals)
			.where(inArray(threadGoals.sessionId, ids))
			.orderBy(
				sql`case when ${threadGoals.sessionId} like '%__durable__solve__run__%' then 0 else 1 end`,
				desc(threadGoals.createdAt),
			)
			.limit(1);
		return row ? toGoalFlowGoalRecord(row) : null;
	}

	async listGoalFlowEvents(input: {
		sessionId: string;
		limit?: number;
	}): Promise<GoalFlowEventRecord[]> {
		const rows = await this.database
			.select({
				sequence: sessionEvents.sequence,
				type: sessionEvents.type,
				data: sessionEvents.data,
				createdAt: sessionEvents.createdAt,
			})
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, input.sessionId),
					inArray(sessionEvents.type, GOAL_FLOW_EVENT_TYPES),
				),
			)
			.orderBy(asc(sessionEvents.sequence))
			.limit(
				typeof input.limit === "number"
					? Math.max(1, Math.trunc(input.limit))
					: 5000,
			);
		return rows.map((row) => ({
			sequence: row.sequence,
			type: row.type,
			data: (row.data ?? {}) as Record<string, unknown>,
			createdAt: row.createdAt,
		}));
	}
}

const CODE_CHECKPOINT_STATUSES = new Set<WorkflowCodeCheckpointStatus>([
	"created",
	"no_changes",
	"skipped",
	"error",
]);

function adapterRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adapterString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function adapterNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function normalizeCodeCheckpointStatus(value: unknown): WorkflowCodeCheckpointStatus {
	const text = adapterString(value);
	if (text && CODE_CHECKPOINT_STATUSES.has(text as WorkflowCodeCheckpointStatus)) {
		return text as WorkflowCodeCheckpointStatus;
	}
	return "skipped";
}

function normalizeChangedFiles(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.filter(adapterRecord).map((item) => ({ ...item }));
}

function parseCheckpointTimestamp(value: unknown): Date | null {
	const text = adapterString(value);
	if (!text) return null;
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sha256Utf8(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function codeCheckpointRowToReadModel(
	row: typeof workflowCodeCheckpoints.$inferSelect,
): WorkflowCodeCheckpointReadModel {
	return {
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowAgentRunId: row.workflowAgentRunId,
		parentExecutionId: row.parentExecutionId,
		daprInstanceId: row.daprInstanceId,
		workspaceRef: row.workspaceRef,
		sandboxName: row.sandboxName,
		repoPath: row.repoPath,
		nodeId: row.nodeId,
		sourceEventId: row.sourceEventId,
		seq: row.seq,
		toolName: row.toolName,
		checkpointKind: row.checkpointKind,
		beforeSha: row.beforeSha,
		afterSha: row.afterSha,
		remoteUrl: row.remoteUrl,
		remoteRef: row.remoteRef,
		remoteStatus: row.remoteStatus,
		remoteError: row.remoteError,
		remotePushedAt: row.remotePushedAt?.toISOString() ?? null,
		changedFiles: normalizeChangedFiles(row.changedFiles),
		fileCount: row.fileCount,
		status: row.status,
		error: row.error,
		metadata: adapterRecord(row.metadata) ? row.metadata : null,
		createdAt: row.createdAt.toISOString(),
	};
}

export class PostgresWorkflowCodeCheckpointStore implements WorkflowCodeCheckpointStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async persistFromAgentEvent(input: PersistCodeCheckpointInput): Promise<void> {
		if (!adapterRecord(input.payload)) return;

		const changedFiles = normalizeChangedFiles(input.payload.changedFiles);
		const sourceEventId =
			adapterString(input.payload.sourceEventId) ?? input.sourceEventId;
		const fileCount = adapterNumber(input.payload.fileCount) ?? changedFiles.length;

		await this.database
			.insert(workflowCodeCheckpoints)
			.values({
				workflowExecutionId: input.workflowExecutionId,
				workflowAgentRunId: input.workflowAgentRunId ?? null,
				parentExecutionId:
					input.parentExecutionId ?? adapterString(input.payload.parentExecutionId),
				daprInstanceId: input.daprInstanceId,
				workspaceRef: adapterString(input.payload.workspaceRef),
				sandboxName: adapterString(input.payload.sandboxName),
				repoPath: adapterString(input.payload.repoPath) ?? "/sandbox",
				nodeId: input.nodeId ?? adapterString(input.payload.nodeId),
				sourceEventId,
				seq: input.seq ?? adapterNumber(input.payload.seq),
				toolName: adapterString(input.payload.toolName) ?? input.toolName,
				checkpointKind: "tool_mutation",
				beforeSha: adapterString(input.payload.beforeSha),
				afterSha: adapterString(input.payload.afterSha),
				remoteUrl: adapterString(input.payload.remoteUrl),
				remoteRef: adapterString(input.payload.remoteRef),
				remoteStatus: adapterString(input.payload.remoteStatus),
				remoteError: adapterString(input.payload.remoteError),
				remotePushedAt: parseCheckpointTimestamp(input.payload.remotePushedAt),
				changedFiles,
				fileCount,
				status: normalizeCodeCheckpointStatus(input.payload.status),
				error: adapterString(input.payload.error),
				metadata: adapterRecord(input.payload.metadata)
					? input.payload.metadata
					: {
							toolCallId: adapterString(input.payload.toolCallId),
							createdBy: "dapr-agent-py",
						},
			})
			.onConflictDoNothing({
				target: [
					workflowCodeCheckpoints.workflowExecutionId,
					workflowCodeCheckpoints.daprInstanceId,
					workflowCodeCheckpoints.sourceEventId,
					workflowCodeCheckpoints.checkpointKind,
				],
			});
	}

	async listForExecution(
		executionId: string,
	): Promise<WorkflowCodeCheckpointReadModel[]> {
		const rows = await this.database
			.select()
			.from(workflowCodeCheckpoints)
			.where(eq(workflowCodeCheckpoints.workflowExecutionId, executionId))
			.orderBy(
				asc(workflowCodeCheckpoints.seq),
				asc(workflowCodeCheckpoints.createdAt),
			);
		return rows.map(codeCheckpointRowToReadModel);
	}
}

export class PostgresEvaluationArtifactStore implements EvaluationArtifactStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async recordCodeCheckpointWarning(input: {
		workflowExecutionId: string;
		sourceEventId: string;
		checkpoint: Record<string, unknown>;
	}): Promise<void> {
		const [evalItem] = await this.database
			.select({
				id: evaluationRunItems.id,
				runId: evaluationRunItems.runId,
			})
			.from(evaluationRunItems)
			.where(eq(evaluationRunItems.workflowExecutionId, input.workflowExecutionId))
			.limit(1);
		if (!evalItem) return;

		const content = {
			warning: "Code checkpoint remote push failed",
			checkpoint: input.checkpoint,
		};
		const body = JSON.stringify(content);
		await this.database.insert(evaluationArtifacts).values({
			runId: evalItem.runId,
			runItemId: evalItem.id,
			kind: "logs" as EvaluationArtifactKind,
			path: `warnings/code-checkpoint/${input.sourceEventId}.json`,
			content,
			contentType: "application/json",
			sizeBytes: Buffer.byteLength(body, "utf8"),
			sha256: sha256Utf8(body),
			metadata: {
				artifactWarning: true,
				source: "code_checkpoint",
			},
		});
	}
}

function usageScopeClause(scope: UsageReportingScope) {
	return scope.projectId
		? sql`s.project_id = ${scope.projectId}`
		: sql`s.user_id = ${scope.userId}`;
}

export class PostgresUsageReportingRepository implements UsageReportingRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getUsageAnalytics(input: {
		scope: UsageReportingScope;
		start: Date;
		end: Date;
	}): Promise<UsageAnalyticsSnapshot> {
		const scopeClause = usageScopeClause(input.scope);
		const startIso = input.start.toISOString();
		const endIso = input.end.toISOString();

		const [tokenTotals] = await this.database.execute<{
			tokens_in: number;
			tokens_out: number;
			cache_read: number;
			cache_create: number;
		}>(sql`
			SELECT
				coalesce(sum((se.data->>'input_tokens')::bigint), 0) AS tokens_in,
				coalesce(sum((se.data->>'output_tokens')::bigint), 0) AS tokens_out,
				coalesce(sum((se.data->>'cache_read_input_tokens')::bigint), 0) AS cache_read,
				coalesce(sum((se.data->>'cache_creation_input_tokens')::bigint), 0) AS cache_create
			FROM ${sessionEvents} se
			JOIN ${sessions} s ON s.id = se.session_id
			WHERE se.type = 'agent.llm_usage'
				AND ${scopeClause}
				AND se.created_at >= ${startIso}
				AND se.created_at <= ${endIso}
		`);

		const [sessionTotals] = await this.database.execute<{ session_count: number }>(sql`
			SELECT count(*)::int AS session_count
			FROM ${sessions} s
			WHERE ${scopeClause}
				AND s.created_at >= ${startIso}
				AND s.created_at <= ${endIso}
		`);

		const daily = await this.database.execute<{
			day: string;
			tokens_in: number;
			tokens_out: number;
		}>(sql`
			WITH days AS (
				SELECT generate_series(${startIso}::date, ${endIso}::date, '1 day'::interval)::date AS day
			),
			scoped_events AS (
				SELECT se.created_at, se.data
				FROM ${sessionEvents} se
				JOIN ${sessions} s ON s.id = se.session_id
				WHERE se.type = 'agent.llm_usage'
					AND ${scopeClause}
					AND se.created_at >= ${startIso}
					AND se.created_at <= ${endIso}
			)
			SELECT
				days.day::text AS day,
				coalesce(sum((scoped_events.data->>'input_tokens')::bigint), 0) AS tokens_in,
				coalesce(sum((scoped_events.data->>'output_tokens')::bigint), 0) AS tokens_out
			FROM days
			LEFT JOIN scoped_events ON date(scoped_events.created_at) = days.day
			GROUP BY days.day
			ORDER BY days.day ASC
		`);

		const byAgent = await this.database.execute<{
			agent_id: string | null;
			agent_name: string | null;
			tokens_in: number;
			tokens_out: number;
			sessions: number;
		}>(sql`
			WITH scoped_sessions AS (
				SELECT s.id, s.agent_id, a.name AS agent_name
				FROM ${sessions} s
				LEFT JOIN ${agents} a ON a.id = s.agent_id
				WHERE ${scopeClause}
					AND s.created_at >= ${startIso}
					AND s.created_at <= ${endIso}
			)
			SELECT
				scoped_sessions.agent_id,
				scoped_sessions.agent_name,
				coalesce(sum((se.data->>'input_tokens')::bigint), 0) AS tokens_in,
				coalesce(sum((se.data->>'output_tokens')::bigint), 0) AS tokens_out,
				count(DISTINCT scoped_sessions.id)::int AS sessions
			FROM scoped_sessions
			LEFT JOIN ${sessionEvents} se
				ON se.session_id = scoped_sessions.id
				AND se.type = 'agent.llm_usage'
				AND se.created_at >= ${startIso}
				AND se.created_at <= ${endIso}
			GROUP BY scoped_sessions.agent_id, scoped_sessions.agent_name
			ORDER BY tokens_out DESC
			LIMIT 20
		`);

		const [toolCalls] = await this.database.execute<{ count: number }>(sql`
			SELECT count(*)::int AS count
			FROM ${sessionEvents} se
			JOIN ${sessions} s ON s.id = se.session_id
			WHERE se.type IN ('agent.tool_use', 'agent.mcp_tool_use', 'agent.custom_tool_use')
				AND ${scopeClause}
				AND se.created_at >= ${startIso}
				AND se.created_at <= ${endIso}
		`);

		return {
			totals: {
				tokensIn: Number(tokenTotals?.tokens_in ?? 0),
				tokensOut: Number(tokenTotals?.tokens_out ?? 0),
				cacheReadTokens: Number(tokenTotals?.cache_read ?? 0),
				cacheCreateTokens: Number(tokenTotals?.cache_create ?? 0),
				sessionCount: Number(sessionTotals?.session_count ?? 0),
				toolCalls: Number(toolCalls?.count ?? 0),
			},
			daily: daily.map((row) => ({
				day: String(row.day),
				tokensIn: Number(row.tokens_in),
				tokensOut: Number(row.tokens_out),
			})),
			byAgent: byAgent.map((row) => ({
				agentId: String(row.agent_id),
				agentName: row.agent_name ?? null,
				tokensIn: Number(row.tokens_in),
				tokensOut: Number(row.tokens_out),
				sessions: Number(row.sessions),
			})),
		};
	}

	async listCostUsageRows(input: {
		scope: UsageReportingScope;
		start: Date;
		end: Date;
	}): Promise<UsageCostRow[]> {
		const scopeClause = usageScopeClause(input.scope);
		const startIso = input.start.toISOString();
		const endIso = input.end.toISOString();
		const rows = await this.database.execute<{
			agent_id: string | null;
			model_spec: string | null;
			agent_name: string | null;
			sessions: number;
			input_tokens: number;
			output_tokens: number;
			cache_read: number;
			cache_create: number;
		}>(sql`
			SELECT
				s.agent_id AS agent_id,
				coalesce(se.data->>'model', se.data->>'providerModel', 'unknown') AS model_spec,
				a.name AS agent_name,
				count(DISTINCT s.id)::int AS sessions,
				coalesce(sum((se.data->>'input_tokens')::bigint), 0) AS input_tokens,
				coalesce(sum((se.data->>'output_tokens')::bigint), 0) AS output_tokens,
				coalesce(sum((se.data->>'cache_read_input_tokens')::bigint), 0) AS cache_read,
				coalesce(sum((se.data->>'cache_creation_input_tokens')::bigint), 0) AS cache_create
			FROM ${sessionEvents} se
			JOIN ${sessions} s ON s.id = se.session_id
			LEFT JOIN ${agents} a ON a.id = s.agent_id
			WHERE se.type = 'agent.llm_usage'
				AND ${scopeClause}
				AND se.created_at >= ${startIso}
				AND se.created_at <= ${endIso}
			GROUP BY s.agent_id, coalesce(se.data->>'model', se.data->>'providerModel', 'unknown'), a.name
		`);
		return rows.map((row) => ({
			agentId: String(row.agent_id),
			agentName: row.agent_name ?? null,
			modelSpec: row.model_spec,
			sessions: Number(row.sessions),
			inputTokens: Number(row.input_tokens),
			outputTokens: Number(row.output_tokens),
			cacheReadTokens: Number(row.cache_read),
			cacheCreateTokens: Number(row.cache_create),
		}));
	}

	async getLiveLimitSnapshot(input: {
		scope: UsageReportingScope;
		now: Date;
	}): Promise<LiveLimitSnapshot> {
		const scopeClause = usageScopeClause(input.scope);
		const nowIso = input.now.toISOString();
		const [active] = await this.database.execute<{ n: number }>(sql`
			SELECT count(*)::int AS n
			FROM ${sessions} s
			WHERE ${scopeClause} AND s.status = 'running'
		`);
		const rows = await this.database.execute<{
			model: string;
			sessions_last_hour: number;
			tokens_in_last_hour: number;
			tokens_out_last_hour: number;
			tokens_in_last_minute: number;
			tokens_out_last_minute: number;
		}>(sql`
			SELECT
				coalesce(se.data->>'model', se.data->>'providerModel', 'unknown') AS model,
				count(DISTINCT s.id) FILTER (
					WHERE s.created_at > ${nowIso}::timestamptz - interval '1 hour'
				)::int AS sessions_last_hour,
				coalesce(sum((se.data->>'input_tokens')::bigint) FILTER (
					WHERE se.created_at > ${nowIso}::timestamptz - interval '1 hour'
				), 0)::bigint AS tokens_in_last_hour,
				coalesce(sum((se.data->>'output_tokens')::bigint) FILTER (
					WHERE se.created_at > ${nowIso}::timestamptz - interval '1 hour'
				), 0)::bigint AS tokens_out_last_hour,
				coalesce(sum((se.data->>'input_tokens')::bigint) FILTER (
					WHERE se.created_at > ${nowIso}::timestamptz - interval '1 minute'
				), 0)::bigint AS tokens_in_last_minute,
				coalesce(sum((se.data->>'output_tokens')::bigint) FILTER (
					WHERE se.created_at > ${nowIso}::timestamptz - interval '1 minute'
				), 0)::bigint AS tokens_out_last_minute
			FROM ${sessionEvents} se
			JOIN ${sessions} s ON s.id = se.session_id
			WHERE se.type = 'agent.llm_usage'
				AND ${scopeClause}
				AND se.created_at > ${nowIso}::timestamptz - interval '2 hours'
			GROUP BY coalesce(se.data->>'model', se.data->>'providerModel', 'unknown')
			ORDER BY sessions_last_hour DESC
		`);
		return {
			activeSessions: Number(active?.n ?? 0),
			byModel: rows.map((row) => ({
				model: String(row.model),
				sessionsLastHour: Number(row.sessions_last_hour),
				tokensInLastHour: Number(row.tokens_in_last_hour),
				tokensOutLastHour: Number(row.tokens_out_last_hour),
				tokensInLastMinute: Number(row.tokens_in_last_minute),
				tokensOutLastMinute: Number(row.tokens_out_last_minute),
			})),
		};
	}
}

export class PostgresSandboxInventoryRepository implements SandboxInventoryRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listRecentExecutionsForSandbox(sandboxName: string): Promise<SandboxExecutionRecord[]> {
		const runtimeName = sandboxName.trim();
		if (!runtimeName) return [];
		let executionIds: string[] | null = null;
		if (runtimeName === "dapr-agent-py" || runtimeName === "dapr-agent-py-testing") {
			const sessionRows = await this.database
				.select({ workflowExecutionId: sessions.workflowExecutionId })
				.from(sessions)
				.where(
					sql`${sessions.sandboxName} = ${runtimeName} AND ${sessions.workflowExecutionId} IS NOT NULL`,
				)
				.orderBy(desc(sessions.createdAt))
				.limit(50);
			executionIds = [
				...new Set(
					sessionRows
						.map((row) => row.workflowExecutionId)
						.filter((id): id is string => typeof id === "string" && id.length > 0),
				),
			].slice(0, 10);
			if (executionIds.length === 0) return [];
		}

		const rows = await this.database
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
			})
			.from(workflowExecutions)
			.leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(
				executionIds && executionIds.length > 0
					? inArray(workflowExecutions.id, executionIds)
					: sql`${workflowExecutions.output}::text LIKE ${`%${runtimeName}%`}`,
			)
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(10);

		return rows.map((row) => ({
			executionId: row.id,
			workflowId: row.workflowId,
			workflowName: row.workflowName ?? null,
			status: row.status,
			startedAt: row.startedAt ?? null,
			completedAt: row.completedAt ?? null,
		}));
	}

	async countExecutionsSince(cutoff: Date): Promise<number> {
		const [row] = await this.database
			.select({ count: sql<number>`count(*)` })
			.from(workflowExecutions)
			.where(gte(workflowExecutions.startedAt, cutoff));
		return Number(row?.count ?? 0);
	}
}

function mapWorkflow(row: Workflow): WorkflowDefinition {
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		userId: row.userId,
		projectId: row.projectId,
		nodes: Array.isArray(row.nodes) ? row.nodes : [],
		edges: Array.isArray(row.edges) ? row.edges : [],
		specVersion: row.specVersion,
		spec: row.spec,
		visibility: row.visibility,
		engineType: row.engineType,
		daprWorkflowName: row.daprWorkflowName,
		daprOrchestratorUrl: row.daprOrchestratorUrl,
		mlflowExperimentId: row.mlflowExperimentId,
		mlflowExperimentName: row.mlflowExperimentName,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapExecution(row: WorkflowExecution): WorkflowExecutionRecord {
	return {
		id: row.id,
		workflowId: row.workflowId,
		userId: row.userId,
		projectId: row.projectId,
		status: row.status,
		input: row.input ?? null,
		output: row.output,
		executionIrVersion: row.executionIrVersion,
		executionIr: row.executionIr,
		error: row.error,
		daprInstanceId: row.daprInstanceId,
		phase: row.phase,
		progress: row.progress,
		currentNodeId: row.currentNodeId,
		currentNodeName: row.currentNodeName,
		primaryTraceId: row.primaryTraceId,
		workflowSessionId: row.workflowSessionId,
		mlflowExperimentId: row.mlflowExperimentId,
		mlflowRunId: row.mlflowRunId,
		summaryOutput: row.summaryOutput,
		errorStackTrace: row.errorStackTrace,
		rerunOfExecutionId: row.rerunOfExecutionId,
		rerunSourceInstanceId: row.rerunSourceInstanceId,
		resumeFromNode: row.resumeFromNode,
		triggerSource: row.triggerSource,
		rerunFromEventId: row.rerunFromEventId,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		duration: row.duration,
		stopRequestedAt: row.stopRequestedAt,
		stopReason: row.stopReason,
	};
}

function mapExecutionLog(row: WorkflowExecutionLog): WorkflowExecutionLogRecord {
	return {
		id: row.id,
		executionId: row.executionId,
		nodeId: row.nodeId,
		nodeName: row.nodeName,
		nodeType: row.nodeType,
		activityName: row.activityName,
		status: row.status,
		input: row.input,
		output: row.output,
		error: row.error,
		startedAt: row.startedAt,
		completedAt: row.completedAt,
		duration: row.duration,
		timestamp: row.timestamp,
		credentialFetchMs: row.credentialFetchMs,
		routingMs: row.routingMs,
		coldStartMs: row.coldStartMs,
		executionMs: row.executionMs,
		routedTo: row.routedTo,
		wasColdStart: row.wasColdStart,
	};
}

function mapWorkflowFile(row: typeof files.$inferSelect): WorkflowFileRecord {
	return {
		id: row.id,
		name: row.name,
		purpose: row.purpose,
		scopeId: row.scopeId ?? null,
		contentType: row.contentType ?? null,
		sizeBytes: row.sizeBytes,
		sha1: row.sha1 ?? null,
		createdAt: row.createdAt.toISOString(),
		archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
	};
}

function mapArtifact(row: WorkflowArtifactRow): WorkflowArtifactRecord {
	return {
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		nodeId: row.nodeId,
		slot: row.slot ?? null,
		kind: row.kind,
		title: row.title,
		description: row.description,
		inlinePayload: row.inlinePayload,
		fileId: row.fileId,
		contentType: row.contentType,
		sizeBytes: row.sizeBytes,
		metadata: row.metadata,
		createdAt: row.createdAt,
	};
}

function mapPlanArtifact(row: WorkflowPlanArtifact): WorkflowPlanArtifactRecord {
	return {
		artifactRef: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowId: row.workflowId,
		userId: row.userId,
		nodeId: row.nodeId,
		workspaceRef: row.workspaceRef,
		clonePath: row.clonePath,
		artifactType: row.artifactType,
		artifactVersion: row.artifactVersion,
		status: row.status,
		goal: row.goal,
		planJson:
			row.planJson && typeof row.planJson === "object"
				? (row.planJson as Record<string, unknown>)
				: {},
		planMarkdown: row.planMarkdown,
		sourcePrompt: row.sourcePrompt,
		metadata: row.metadata,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function mapTrigger(row: typeof workflowTriggers.$inferSelect): WorkflowTriggerRecord {
	return {
		id: row.id,
		workflowId: row.workflowId,
		userId: row.userId,
		projectId: row.projectId,
		kind: row.kind,
		config: row.config ?? {},
		triggerData: row.triggerData ?? null,
		dedupSalt: row.dedupSalt,
		backingRef: row.backingRef,
		status: row.status,
		lastError: row.lastError,
		lastFiredAt: row.lastFiredAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export class PostgresUserProfileRepository implements UserProfileRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getUserProfile(userId: string): Promise<UserProfileRecord | null> {
		const [row] = await this.database
			.select({
				name: users.name,
				email: users.email,
				image: users.image,
				platformRole: users.platformRole,
			})
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		if (!row) return null;
		const platformRole: UserProfileRecord["platformRole"] =
			row.platformRole === "ADMIN" ? "ADMIN" : "MEMBER";
		return {
			name: row.name,
			email: row.email,
			image: row.image,
			platformRole,
		};
	}
}

export class PostgresSettingsRepository implements SettingsRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getSettingsUserProfile(userId: string) {
		const [row] = await this.database
			.select({
				id: users.id,
				name: users.name,
				email: users.email,
				image: users.image,
				platformId: users.platformId,
				platformRole: users.platformRole,
			})
			.from(users)
			.where(eq(users.id, userId))
			.limit(1);
		return row ?? null;
	}

	listPlatformOAuthApps(platformId: string) {
		return this.database
			.select({
				id: platformOauthApps.id,
				pieceName: platformOauthApps.pieceName,
				clientId: platformOauthApps.clientId,
				createdAt: platformOauthApps.createdAt,
				updatedAt: platformOauthApps.updatedAt,
			})
			.from(platformOauthApps)
			.where(eq(platformOauthApps.platformId, platformId))
			.orderBy(platformOauthApps.pieceName);
	}

	listOAuthPieces() {
		return this.database
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
			})
			.from(pieceMetadata)
			.where(
				sql`${pieceMetadata.auth}->>'type' = 'OAUTH2' AND ${pieceMetadata.availableOnly} = false`,
			)
			.orderBy(pieceMetadata.name, pieceMetadata.displayName);
	}

	async resolvePlatformId(sessionPlatformId?: string | null) {
		if (sessionPlatformId) return sessionPlatformId;

		const [existing] = await this.database
			.select({ id: platforms.id })
			.from(platforms)
			.orderBy(platforms.createdAt)
			.limit(1);
		if (existing?.id) return existing.id;

		const now = new Date();
		const [created] = await this.database
			.insert(platforms)
			.values({
				id: "default-platform",
				name: "Default Platform",
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoNothing()
			.returning({ id: platforms.id });
		if (created?.id) return created.id;

		const [winner] = await this.database
			.select({ id: platforms.id })
			.from(platforms)
			.orderBy(platforms.createdAt)
			.limit(1);
		if (!winner?.id) throw new Error("Platform could not be resolved");
		return winner.id;
	}

	async savePlatformOAuthApp(input: {
		id?: string | null;
		platformId?: string | null;
		pieceName: string;
		clientId: string;
		encryptedClientSecret?: { iv: string; data: string } | null;
	}) {
		const mutationFields = {
			id: platformOauthApps.id,
			platformId: platformOauthApps.platformId,
			pieceName: platformOauthApps.pieceName,
			clientId: platformOauthApps.clientId,
			createdAt: platformOauthApps.createdAt,
			updatedAt: platformOauthApps.updatedAt,
		};
		const now = new Date();

		if (!input.platformId) {
			const updateData: Partial<typeof platformOauthApps.$inferInsert> = {
				clientId: input.clientId,
				updatedAt: now,
			};
			if (input.encryptedClientSecret) {
				updateData.clientSecret = input.encryptedClientSecret;
			}
			const [updated] = await this.database
				.update(platformOauthApps)
				.set(updateData)
				.where(eq(platformOauthApps.id, String(input.id)))
				.returning(mutationFields);
			return updated ?? null;
		}

		if (!input.encryptedClientSecret) {
			throw new Error("clientSecret is required when creating an OAuth app");
		}

		const [app] = await this.database
			.insert(platformOauthApps)
			.values({
				id: input.id ?? undefined,
				platformId: input.platformId,
				pieceName: input.pieceName,
				clientId: input.clientId,
				clientSecret: input.encryptedClientSecret,
				createdAt: now,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [platformOauthApps.platformId, platformOauthApps.pieceName],
				set: {
					clientId: input.clientId,
					clientSecret: input.encryptedClientSecret,
					updatedAt: now,
				},
			})
			.returning(mutationFields);

		return app ?? null;
	}

	async deletePlatformOAuthApp(id: string) {
		await this.database.delete(platformOauthApps).where(eq(platformOauthApps.id, id));
	}
}

export class PostgresMcpConnectionRepository implements McpConnectionRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	private mapConnection(row: typeof mcpConnections.$inferSelect): McpConnectionRecord {
		return {
			id: row.id,
			projectId: row.projectId,
			sourceType: row.sourceType,
			pieceName: row.pieceName,
			serverKey: row.serverKey,
			connectionExternalId: row.connectionExternalId,
			displayName: row.displayName,
			registryRef: row.registryRef,
			serverUrl: row.serverUrl,
			status: row.status,
			lastSyncAt: row.lastSyncAt,
			lastError: row.lastError,
			metadata: row.metadata,
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	async listProjectConnections(projectId: string) {
		const rows = await this.database
			.select()
			.from(mcpConnections)
			.where(eq(mcpConnections.projectId, projectId))
			.orderBy(mcpConnections.displayName);
		return rows.map((row) => this.mapConnection(row));
	}

	async findProjectConnection(input: { id: string; projectId: string }) {
		const [row] = await this.database
			.select()
			.from(mcpConnections)
			.where(
				and(
					eq(mcpConnections.id, input.id),
					eq(mcpConnections.projectId, input.projectId),
				),
			)
			.limit(1);
		return row ? this.mapConnection(row) : null;
	}

	async findProjectNimblePieceConnection(input: {
		projectId: string;
		pieceName: string;
	}) {
		const [row] = await this.database
			.select()
			.from(mcpConnections)
			.where(
				and(
					eq(mcpConnections.projectId, input.projectId),
					eq(mcpConnections.sourceType, "nimble_piece"),
					eq(mcpConnections.pieceName, input.pieceName),
				),
			)
			.limit(1);
		return row ? this.mapConnection(row) : null;
	}

	async createProjectConnection(input: CreateMcpConnectionRecordInput) {
		const [row] = await this.database
			.insert(mcpConnections)
			.values({
				id: input.id,
				projectId: input.projectId,
				sourceType: input.sourceType,
				pieceName: input.pieceName,
				serverKey: input.serverKey,
				connectionExternalId: input.connectionExternalId,
				displayName: input.displayName,
				registryRef: input.registryRef,
				serverUrl: input.serverUrl,
				status: input.status,
				lastSyncAt: input.lastSyncAt ?? null,
				lastError: input.lastError ?? null,
				metadata: input.metadata,
				createdBy: input.createdBy,
				updatedBy: input.updatedBy,
			})
			.returning();
		return this.mapConnection(row);
	}

	async updateProjectConnection(input: {
		id: string;
		projectId: string;
		status?: McpConnectionRecord["status"];
		connectionExternalId?: string | null;
		displayName?: string;
		registryRef?: string | null;
		serverUrl?: string | null;
		metadata?: Record<string, unknown> | null;
		updatedBy: string;
	}) {
		const updates: Partial<typeof mcpConnections.$inferInsert> = {
			updatedBy: input.updatedBy,
			updatedAt: new Date(),
		};
		if (input.status !== undefined) updates.status = input.status;
		if (Object.hasOwn(input, "connectionExternalId")) {
			updates.connectionExternalId = input.connectionExternalId ?? null;
		}
		if (input.displayName !== undefined) updates.displayName = input.displayName;
		if (Object.hasOwn(input, "registryRef")) updates.registryRef = input.registryRef ?? null;
		if (Object.hasOwn(input, "serverUrl")) updates.serverUrl = input.serverUrl ?? null;
		if (Object.hasOwn(input, "metadata")) updates.metadata = input.metadata ?? null;

		const [row] = await this.database
			.update(mcpConnections)
			.set(updates)
			.where(
				and(
					eq(mcpConnections.id, input.id),
					eq(mcpConnections.projectId, input.projectId),
				),
			)
			.returning();
		return row ? this.mapConnection(row) : null;
	}

	async deleteProjectConnection(input: { id: string; projectId: string }) {
		await this.database
			.delete(mcpConnections)
			.where(
				and(
					eq(mcpConnections.id, input.id),
					eq(mcpConnections.projectId, input.projectId),
				),
			);
	}

	async activeAppConnectionExistsForPiece(input: {
		projectId: string;
		externalId: string;
		pieceNameCandidates: string[];
	}) {
		if (input.pieceNameCandidates.length === 0) return false;
		const [row] = await this.database
			.select({ projectIds: appConnections.projectIds })
			.from(appConnections)
			.where(
				and(
					eq(appConnections.externalId, input.externalId),
					eq(appConnections.status, AppConnectionStatus.ACTIVE),
					inArray(appConnections.pieceName, input.pieceNameCandidates),
				),
			)
			.limit(1);
		return Boolean(row && connectionBelongsToProject(row.projectIds, input.projectId));
	}

	async listActiveAppConnectionCatalogSummaries(
		projectId: string,
	): Promise<McpCatalogAppConnectionSummary[]> {
		const rows = await this.database
			.select({
				id: appConnections.id,
				externalId: appConnections.externalId,
				displayName: appConnections.displayName,
				pieceName: appConnections.pieceName,
				type: appConnections.type,
				status: appConnections.status,
				projectIds: appConnections.projectIds,
			})
			.from(appConnections)
			.where(eq(appConnections.status, AppConnectionStatus.ACTIVE))
			.orderBy(desc(appConnections.createdAt));
		return rows
			.filter((row) => connectionBelongsToProject(row.projectIds, projectId))
			.map(({ projectIds: _projectIds, ...row }) => row);
	}

	async listPlatformOAuthAppPieceNames(input: {
		pieceNames: string[];
		platformId?: string | null;
	}) {
		if (input.pieceNames.length === 0) return [];
		const rows = await this.database
			.select({
				pieceName: platformOauthApps.pieceName,
				platformId: platformOauthApps.platformId,
			})
			.from(platformOauthApps)
			.where(inArray(platformOauthApps.pieceName, input.pieceNames));
		return rows
			.filter((row) => !input.platformId || row.platformId === input.platformId)
			.map((row) => row.pieceName);
	}
}

export class PostgresHostedMcpServerRepository implements HostedMcpServerRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	private mapServer(row: typeof mcpServers.$inferSelect): HostedMcpServerRecord {
		return {
			id: row.id,
			projectId: row.projectId,
			status: row.status,
			tokenEncrypted: row.tokenEncrypted,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	private mapConnection(row: typeof mcpConnections.$inferSelect): McpConnectionRecord {
		return {
			id: row.id,
			projectId: row.projectId,
			sourceType: row.sourceType,
			pieceName: row.pieceName,
			serverKey: row.serverKey,
			connectionExternalId: row.connectionExternalId,
			displayName: row.displayName,
			registryRef: row.registryRef,
			serverUrl: row.serverUrl,
			status: row.status,
			lastSyncAt: row.lastSyncAt,
			lastError: row.lastError,
			metadata: row.metadata,
			createdBy: row.createdBy,
			updatedBy: row.updatedBy,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	async resolveProjectByIdOrExternalId(projectRef: string) {
		const [row] = await this.database
			.select({ id: projects.id, externalId: projects.externalId })
			.from(projects)
			.where(or(eq(projects.id, projectRef), eq(projects.externalId, projectRef)))
			.limit(1);
		return row ?? null;
	}

	async getServerByProjectId(projectId: string) {
		const [row] = await this.database
			.select()
			.from(mcpServers)
			.where(eq(mcpServers.projectId, projectId))
			.limit(1);
		return row ? this.mapServer(row) : null;
	}

	async createServer(input: {
		id: string;
		projectId: string;
		status: HostedMcpServerRecord["status"];
		tokenEncrypted: HostedMcpServerRecord["tokenEncrypted"];
	}) {
		const [row] = await this.database
			.insert(mcpServers)
			.values({
				id: input.id,
				projectId: input.projectId,
				status: input.status,
				tokenEncrypted: input.tokenEncrypted,
			})
			.returning();
		return this.mapServer(row);
	}

	async updateServerStatus(input: {
		id: string;
		status: HostedMcpServerRecord["status"];
	}) {
		await this.database
			.update(mcpServers)
			.set({ status: input.status, updatedAt: new Date() })
			.where(eq(mcpServers.id, input.id));
	}

	async updateServerToken(input: {
		id: string;
		tokenEncrypted: HostedMcpServerRecord["tokenEncrypted"];
	}) {
		await this.database
			.update(mcpServers)
			.set({ tokenEncrypted: input.tokenEncrypted, updatedAt: new Date() })
			.where(eq(mcpServers.id, input.id));
	}

	async getProjectOwnerId(projectId: string) {
		const [row] = await this.database
			.select({ ownerId: projects.ownerId })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		return row?.ownerId ?? null;
	}

	async listWorkflowSourcesForProject(input: {
		projectId: string;
		ownerId: string;
	}): Promise<HostedMcpWorkflowSourceRecord[]> {
		return this.database
			.select({
				id: workflows.id,
				name: workflows.name,
				description: workflows.description,
				nodes: workflows.nodes,
			})
			.from(workflows)
			.where(
				or(
					eq(workflows.projectId, input.projectId),
					and(isNull(workflows.projectId), eq(workflows.userId, input.ownerId)),
				),
			);
	}

	async upsertHostedWorkflowConnection(input: {
		projectId: string;
		displayName?: string | null;
		serverUrl?: string | null;
		registryRef?: string | null;
		status: McpConnectionRecord["status"];
		metadata?: Record<string, unknown> | null;
		lastError?: string | null;
		actorUserId?: string | null;
	}) {
		const now = new Date();
		const displayName =
			typeof input.displayName === "string" && input.displayName.trim()
				? input.displayName.trim()
				: "Workflow Builder Hosted MCP";
		const [existing] = await this.database
			.select()
			.from(mcpConnections)
			.where(
				and(
					eq(mcpConnections.projectId, input.projectId),
					eq(mcpConnections.sourceType, "hosted_workflow"),
				),
			)
			.limit(1);

		if (existing) {
			const existingMeta = (existing.metadata as Record<string, unknown>) ?? {};
			const mergedMeta = input.metadata
				? { ...existingMeta, ...input.metadata }
				: existingMeta;
			const [row] = await this.database
				.update(mcpConnections)
				.set({
					displayName,
					serverUrl: input.serverUrl ?? existing.serverUrl,
					registryRef: input.registryRef ?? existing.registryRef,
					status: input.status,
					lastSyncAt: now,
					lastError: input.lastError ?? null,
					metadata: Object.keys(mergedMeta).length > 0 ? mergedMeta : null,
					updatedBy: input.actorUserId ?? null,
					updatedAt: now,
				})
				.where(eq(mcpConnections.id, existing.id))
				.returning();
			return this.mapConnection(row);
		}

		const [row] = await this.database
			.insert(mcpConnections)
			.values({
				id: generateId(),
				projectId: input.projectId,
				sourceType: "hosted_workflow",
				pieceName: null,
				serverKey: null,
				displayName,
				registryRef: input.registryRef ?? "mcp-gateway",
				serverUrl: input.serverUrl ?? null,
				status: input.status,
				lastSyncAt: now,
				lastError: input.lastError ?? null,
				metadata: input.metadata ?? null,
				createdBy: input.actorUserId ?? null,
				updatedBy: input.actorUserId ?? null,
			})
			.returning();
		return this.mapConnection(row);
	}
}

export class PostgresMcpRunRepository implements McpRunRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	private mapRun(row: typeof mcpRuns.$inferSelect): McpRunRecord {
		return {
			id: row.id,
			projectId: row.projectId,
			mcpServerId: row.mcpServerId,
			workflowId: row.workflowId,
			workflowExecutionId: row.workflowExecutionId,
			daprInstanceId: row.daprInstanceId,
			toolName: row.toolName,
			input: row.input,
			response: row.response,
			status: row.status,
			respondedAt: row.respondedAt,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	async createRun(input: {
		projectId: string;
		mcpServerId: string;
		workflowId: string;
		toolName: string;
		input: Record<string, unknown>;
	}) {
		const [row] = await this.database
			.insert(mcpRuns)
			.values({
				id: generateId(),
				projectId: input.projectId,
				mcpServerId: input.mcpServerId,
				workflowId: input.workflowId,
				toolName: input.toolName,
				input: input.input,
				status: "STARTED",
			})
			.returning();
		return this.mapRun(row);
	}

	async attachExecution(input: {
		runId: string;
		workflowExecutionId: string;
		daprInstanceId: string | null;
	}) {
		await this.database
			.update(mcpRuns)
			.set({
				workflowExecutionId: input.workflowExecutionId,
				daprInstanceId: input.daprInstanceId ?? null,
				updatedAt: new Date(),
			})
			.where(eq(mcpRuns.id, input.runId));
	}

	async getRun(runId: string) {
		const [row] = await this.database
			.select()
			.from(mcpRuns)
			.where(eq(mcpRuns.id, runId))
			.limit(1);
		return row ? this.mapRun(row) : null;
	}

	async respondToRun(input: { runId: string; response: unknown }) {
		const [row] = await this.database
			.update(mcpRuns)
			.set({
				response: input.response,
				respondedAt: new Date(),
				status: "RESPONDED",
				updatedAt: new Date(),
			})
			.where(eq(mcpRuns.id, input.runId))
			.returning();
		return row ? this.mapRun(row) : null;
	}
}

export class PostgresAppConnectionRepository implements AppConnectionRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	private mapConnection(row: typeof appConnections.$inferSelect): AppConnectionRecord {
		return {
			id: row.id,
			externalId: row.externalId,
			pieceName: row.pieceName,
			displayName: row.displayName,
			type: row.type,
			status: row.status,
			scope: row.scope,
			ownerId: row.ownerId,
			platformId: row.platformId,
			projectIds: row.projectIds,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	private mapSecretConnection(
		row: typeof appConnections.$inferSelect,
	): AppConnectionSecretRecord {
		return {
			...this.mapConnection(row),
			value: row.value,
			pieceVersion: row.pieceVersion ?? null,
		};
	}

	async listProjectConnections(projectId: string) {
		const rows = await this.database
			.select()
			.from(appConnections)
			.orderBy(desc(appConnections.createdAt));
		return rows
			.filter((row) => connectionBelongsToProject(row.projectIds, projectId))
			.map((row) => this.mapConnection(row));
	}

	listConnectionSummaries(input: {
		pieceNameCandidates?: string[];
	}): Promise<AppConnectionSummaryRecord[]> {
		const where =
			input.pieceNameCandidates && input.pieceNameCandidates.length > 0
				? inArray(appConnections.pieceName, input.pieceNameCandidates)
				: undefined;
		return this.database
			.select({
				id: appConnections.id,
				externalId: appConnections.externalId,
				pieceName: appConnections.pieceName,
				displayName: appConnections.displayName,
				type: appConnections.type,
				status: appConnections.status,
				createdAt: appConnections.createdAt,
			})
			.from(appConnections)
			.where(where)
			.orderBy(desc(appConnections.createdAt));
	}

	listPieceInfo() {
		return this.database
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
				categories: pieceMetadata.categories,
			})
			.from(pieceMetadata)
			.orderBy(pieceMetadata.name, desc(pieceMetadata.updatedAt));
	}

	async findConnectionById(id: string): Promise<AppConnectionSecretRecord | null> {
		const [row] = await this.database
			.select()
			.from(appConnections)
			.where(eq(appConnections.id, id))
			.limit(1);
		return row ? this.mapSecretConnection(row) : null;
	}

	async findConnectionByExternalId(
		externalId: string,
	): Promise<AppConnectionSecretRecord | null> {
		const [row] = await this.database
			.select()
			.from(appConnections)
			.where(eq(appConnections.externalId, externalId))
			.limit(1);
		return row ? this.mapSecretConnection(row) : null;
	}

	async findOAuthPieceMetadata(input: {
		pieceNameCandidates: string[];
		pieceVersion?: string | null;
	}): Promise<AppConnectionOAuthPieceMetadataRecord | null> {
		if (input.pieceNameCandidates.length === 0) return null;
		const rows = await this.database
			.select({
				name: pieceMetadata.name,
				version: pieceMetadata.version,
				auth: pieceMetadata.auth,
			})
			.from(pieceMetadata)
			.where(inArray(pieceMetadata.name, input.pieceNameCandidates))
			.orderBy(desc(pieceMetadata.createdAt))
			.limit(5);
		const row = input.pieceVersion
			? rows.find((piece) => piece.version === input.pieceVersion)
			: rows[0];
		return row ?? rows[0] ?? null;
	}

	async findPlatformOAuthApp(input: {
		pieceNameCandidates: string[];
		platformId?: string | null;
	}): Promise<AppConnectionPlatformOAuthAppRecord | null> {
		if (input.pieceNameCandidates.length === 0) return null;
		const where = input.platformId
			? and(
					inArray(platformOauthApps.pieceName, input.pieceNameCandidates),
					eq(platformOauthApps.platformId, input.platformId),
				)
			: inArray(platformOauthApps.pieceName, input.pieceNameCandidates);
		const [row] = await this.database
			.select({
				pieceName: platformOauthApps.pieceName,
				platformId: platformOauthApps.platformId,
				clientId: platformOauthApps.clientId,
				clientSecret: platformOauthApps.clientSecret,
			})
			.from(platformOauthApps)
			.where(where)
			.limit(1);
		return row ?? null;
	}

	async createConnection(input: {
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
	}): Promise<AppConnectionCreatedRecord> {
		const [connection] = await this.database
			.insert(appConnections)
			.values({
				id: input.id,
				externalId: input.externalId,
				pieceName: input.pieceName,
				displayName: input.displayName,
				type: input.type as AppConnectionType,
				status: input.status as AppConnectionStatus,
				value: input.value,
				pieceVersion: input.pieceVersion,
				projectIds: input.projectIds,
				ownerId: input.ownerId,
				platformId: input.platformId,
				scope: input.scope as AppConnectionScope,
			})
			.returning({
				id: appConnections.id,
				externalId: appConnections.externalId,
				pieceName: appConnections.pieceName,
				displayName: appConnections.displayName,
				type: appConnections.type,
				status: appConnections.status,
				scope: appConnections.scope,
				createdAt: appConnections.createdAt,
				updatedAt: appConnections.updatedAt,
			});
		return connection;
	}

	async updateDisplayName(input: {
		id: string;
		projectId: string;
		displayName: string;
	}): Promise<AppConnectionUpdatedRecord | null> {
		const [existing] = await this.database
			.select({ id: appConnections.id, projectIds: appConnections.projectIds })
			.from(appConnections)
			.where(eq(appConnections.id, input.id))
			.limit(1);
		if (!existing || !connectionBelongsToProject(existing.projectIds, input.projectId)) {
			return null;
		}

		const [connection] = await this.database
			.update(appConnections)
			.set({ displayName: input.displayName, updatedAt: new Date() })
			.where(eq(appConnections.id, input.id))
			.returning({
				id: appConnections.id,
				externalId: appConnections.externalId,
				pieceName: appConnections.pieceName,
				displayName: appConnections.displayName,
				type: appConnections.type,
				status: appConnections.status,
				createdAt: appConnections.createdAt,
		});
		return connection ?? null;
	}

	async updateOAuthConnection(input: {
		id: string;
		value: { iv: string; data: string };
		pieceName: string;
		pieceVersion: string;
		projectIds: string[];
	}): Promise<AppConnectionOAuthCompletedRecord | null> {
		const [connection] = await this.database
			.update(appConnections)
			.set({
				status: AppConnectionStatus.ACTIVE,
				type: AppConnectionType.PLATFORM_OAUTH2,
				value: input.value,
				pieceName: input.pieceName,
				pieceVersion: input.pieceVersion,
				projectIds: input.projectIds,
				updatedAt: new Date(),
			})
			.where(eq(appConnections.id, input.id))
			.returning({
				id: appConnections.id,
				externalId: appConnections.externalId,
				pieceName: appConnections.pieceName,
				displayName: appConnections.displayName,
				type: appConnections.type,
				status: appConnections.status,
				createdAt: appConnections.createdAt,
				updatedAt: appConnections.updatedAt,
			});
		return connection ?? null;
	}

	async updateEncryptedValue(input: {
		id: string;
		value: { iv: string; data: string };
	}): Promise<void> {
		await this.database
			.update(appConnections)
			.set({ value: input.value, updatedAt: new Date() })
			.where(eq(appConnections.id, input.id));
	}

	async deleteProjectConnection(input: { id: string; projectId: string }) {
		const [existing] = await this.database
			.select({ id: appConnections.id, projectIds: appConnections.projectIds })
			.from(appConnections)
			.where(eq(appConnections.id, input.id))
			.limit(1);
		if (!existing || !connectionBelongsToProject(existing.projectIds, input.projectId)) {
			return false;
		}

		const deleted = await this.database
			.delete(appConnections)
			.where(eq(appConnections.id, input.id))
			.returning({ id: appConnections.id });
		return deleted.length > 0;
	}
}

export class PostgresAdminPieceRepository implements AdminPieceRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	listCatalogPieces(input: { availableOnly: boolean }) {
		return this.database
			.select({
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
			})
			.from(pieceMetadata)
			.where(
				and(
					eq(pieceMetadata.catalogSchemaVersion, 1),
					eq(pieceMetadata.availableOnly, input.availableOnly),
				),
			);
	}

	async listDisabledPieceNames(): Promise<string[]> {
		const rows = await this.database
			.select({ pieceName: platformDisabledPieces.pieceName })
			.from(platformDisabledPieces);
		return rows.map((row) => row.pieceName).filter(Boolean);
	}

	async listWorkflowReferencedPieceNames(): Promise<string[]> {
		const rows = await this.database
			.selectDistinct({ pieceName: workflowConnectionRefs.pieceName })
			.from(workflowConnectionRefs);
		return rows.map((row) => row.pieceName).filter((name): name is string => Boolean(name));
	}

	async listEnabledMcpPieceNames(): Promise<string[]> {
		const rows = await this.database
			.selectDistinct({ pieceName: mcpConnections.pieceName })
			.from(mcpConnections)
			.where(
				and(
					eq(mcpConnections.sourceType, "nimble_piece"),
					eq(mcpConnections.status, "ENABLED"),
				),
			);
		return rows.map((row) => row.pieceName).filter((name): name is string => Boolean(name));
	}

	async listLatestImageStatuses(pieceNames: string[]) {
		if (pieceNames.length === 0) return [];
		const rows = await this.database
			.select({
				pieceName: pieceImages.pieceName,
				status: pieceImages.status,
				image: pieceImages.image,
				errorMessage: pieceImages.errorMessage,
				enabledAt: pieceImages.enabledAt,
				disabledAt: pieceImages.disabledAt,
			})
			.from(pieceImages)
			.where(inArray(pieceImages.pieceName, pieceNames))
			.orderBy(desc(pieceImages.updatedAt));
		const latest = new Map<
			string,
			{
				pieceName: string;
				status: string;
				image: string | null;
				errorMessage: string | null;
				enabled: boolean;
			}
		>();
		for (const row of rows) {
			if (latest.has(row.pieceName)) continue;
			latest.set(row.pieceName, {
				pieceName: row.pieceName,
				status: row.status,
				image: row.image,
				errorMessage: row.errorMessage,
				enabled: row.enabledAt != null && row.disabledAt == null,
			});
		}
		return [...latest.values()];
	}

	async setPieceEnabled(input: {
		pieceName: string;
		enabled: boolean;
		disabledBy?: string | null;
		platformId?: string;
	}): Promise<void> {
		if (input.enabled) {
			await this.database
				.delete(platformDisabledPieces)
				.where(eq(platformDisabledPieces.pieceName, input.pieceName));
			return;
		}
		await this.database
			.insert(platformDisabledPieces)
			.values({
				pieceName: input.pieceName,
				disabledBy: input.disabledBy ?? null,
				platformId: input.platformId ?? "default-platform",
			})
			.onConflictDoNothing();
	}
}

export class PostgresWorkspaceProjectRepository implements WorkspaceProjectRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getMemberProjectId(input: {
		projectId: string;
		userId: string;
	}): Promise<string | null> {
		const [row] = await this.database
			.select({ projectId: projectMembers.projectId })
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, input.projectId),
					eq(projectMembers.userId, input.userId),
				),
			)
			.limit(1);
		return row?.projectId ?? null;
	}

	async getFallbackMemberProjectId(userId: string): Promise<string | null> {
		const [row] = await this.database
			.select({ projectId: projectMembers.projectId })
			.from(projectMembers)
			.where(eq(projectMembers.userId, userId))
			.limit(1);
		return row?.projectId ?? null;
	}

	async listWorkspaceMemberships(input: {
		userId: string;
	}): Promise<WorkspaceProjectMembershipRecord[]> {
		const rows = await this.database
			.select({
				id: projects.id,
				displayName: projects.displayName,
				externalId: projects.externalId,
				role: projectMembers.role,
				createdAt: projects.createdAt,
			})
			.from(projects)
			.innerJoin(
				projectMembers,
				and(
					eq(projectMembers.projectId, projects.id),
					eq(projectMembers.userId, input.userId),
				),
			)
			.orderBy(asc(projects.createdAt));
		return rows.map((row) => ({
			id: row.id,
			displayName: row.displayName,
			externalId: row.externalId,
			role: row.role as ProjectMembershipRole,
			createdAt: row.createdAt,
		}));
	}

	async createWorkspaceProject(
		input: CreateWorkspaceProjectInput,
	): Promise<WorkspaceProjectMembershipRecord> {
		const [project] = await this.database
			.insert(projects)
			.values({
				platformId: input.platformId,
				ownerId: input.ownerId,
				displayName: input.displayName,
				externalId: input.externalId,
			})
			.returning();
		if (!project) throw new Error("Failed to create workspace");

		await this.database.insert(projectMembers).values({
			projectId: project.id,
			userId: input.ownerId,
			role: "ADMIN",
		});

		return {
			id: project.id,
			displayName: project.displayName,
			externalId: project.externalId,
			role: "ADMIN",
			createdAt: project.createdAt,
		};
	}

	async updateWorkspaceDisplayName(input: {
		projectId: string;
		displayName: string;
	}): Promise<boolean> {
		const [row] = await this.database
			.update(projects)
			.set({ displayName: input.displayName, updatedAt: new Date() })
			.where(eq(projects.id, input.projectId))
			.returning({ id: projects.id });
		return Boolean(row);
	}

	async getMemberProjectIdBySlug(input: {
		slug: string;
		userId: string;
	}): Promise<string | null> {
		const [row] = await this.database
			.select({ projectId: projects.id })
			.from(projects)
			.innerJoin(
				projectMembers,
				and(
					eq(projectMembers.projectId, projects.id),
					eq(projectMembers.userId, input.userId),
				),
			)
			.where(or(eq(projects.externalId, input.slug), eq(projects.id, input.slug)))
			.limit(1);
		return row?.projectId ?? null;
	}

	async getProjectExternalId(projectId: string): Promise<string | null> {
		const [row] = await this.database
			.select({ externalId: projects.externalId })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);
		return row?.externalId ?? null;
	}

	async getProjectMembershipDetail(input: {
		projectId: string;
		userId: string;
	}) {
		const [project] = await this.database
			.select({
				id: projects.id,
				displayName: projects.displayName,
				externalId: projects.externalId,
			})
			.from(projects)
			.where(eq(projects.id, input.projectId))
			.limit(1);
		if (!project) return null;

		const [self] = await this.database
			.select({ role: projectMembers.role })
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, project.id),
					eq(projectMembers.userId, input.userId),
				),
			)
			.limit(1);

		return {
			id: project.id,
			displayName: project.displayName,
			externalId: project.externalId,
			selfRole: self?.role ?? null,
		};
	}

	async getProjectMemberRole(input: {
		projectId: string;
		userId: string;
	}): Promise<ProjectMembershipRole | null> {
		const [row] = await this.database
			.select({ role: projectMembers.role })
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, input.projectId),
					eq(projectMembers.userId, input.userId),
				),
			)
			.limit(1);
		return (row?.role as ProjectMembershipRole | undefined) ?? null;
	}

	async listProjectMembers(projectId: string): Promise<ProjectMemberListItem[]> {
		const rows = await this.database
			.select({
				id: projectMembers.id,
				userId: users.id,
				name: users.name,
				email: users.email,
				image: users.image,
				role: projectMembers.role,
				createdAt: projectMembers.createdAt,
			})
			.from(projectMembers)
			.innerJoin(users, eq(users.id, projectMembers.userId))
			.where(eq(projectMembers.projectId, projectId))
			.orderBy(asc(projectMembers.createdAt));
		return rows.map((row) => ({
			id: row.id,
			userId: row.userId,
			name: row.name ?? null,
			email: row.email ?? null,
			image: row.image ?? null,
			role: row.role as ProjectMembershipRole,
			createdAt: row.createdAt,
		}));
	}

	async findPlatformUserForProject(input: {
		projectId: string;
		userId?: string | null;
		email?: string | null;
	}): Promise<
		| { ok: true; userId: string }
		| {
				ok: false;
				reason: "project_not_found" | "user_not_found" | "different_platform";
		  }
	> {
		const [project] = await this.database
			.select({ platformId: projects.platformId })
			.from(projects)
			.where(eq(projects.id, input.projectId))
			.limit(1);
		if (!project) return { ok: false, reason: "project_not_found" };

		const userId = input.userId?.trim();
		const email = input.email?.trim().toLowerCase();
		const [user] = await this.database
			.select({ id: users.id, platformId: users.platformId })
			.from(users)
			.where(userId ? eq(users.id, userId) : eq(users.email, email ?? ""))
			.limit(1);
		if (!user) return { ok: false, reason: "user_not_found" };
		if (user.platformId !== project.platformId) {
			return { ok: false, reason: "different_platform" };
		}
		return { ok: true, userId: user.id };
	}

	async getProjectMember(input: {
		projectId: string;
		memberId: string;
	}): Promise<ProjectMemberRecord | null> {
		const [row] = await this.database
			.select()
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.id, input.memberId),
					eq(projectMembers.projectId, input.projectId),
				),
			)
			.limit(1);
		return row
			? {
					id: row.id,
					projectId: row.projectId,
					userId: row.userId,
					role: row.role as ProjectMembershipRole,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
				}
			: null;
	}

	async projectMemberExists(input: {
		projectId: string;
		userId: string;
	}): Promise<boolean> {
		const [row] = await this.database
			.select({ id: projectMembers.id })
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, input.projectId),
					eq(projectMembers.userId, input.userId),
				),
			)
			.limit(1);
		return Boolean(row);
	}

	async countProjectAdmins(projectId: string): Promise<number> {
		const [row] = await this.database
			.select({ value: count() })
			.from(projectMembers)
			.where(
				and(
					eq(projectMembers.projectId, projectId),
					eq(projectMembers.role, "ADMIN"),
				),
			);
		return Number(row?.value ?? 0);
	}

	async addProjectMember(input: {
		projectId: string;
		userId: string;
		role: ProjectMembershipRole;
	}): Promise<ProjectMemberRecord> {
		const [row] = await this.database
			.insert(projectMembers)
			.values({
				projectId: input.projectId,
				userId: input.userId,
				role: input.role,
			})
			.returning();
		if (!row) throw new Error("Failed to add project member");
		return {
			id: row.id,
			projectId: row.projectId,
			userId: row.userId,
			role: row.role as ProjectMembershipRole,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	async updateProjectMemberRole(input: {
		projectId: string;
		memberId: string;
		role: ProjectMembershipRole;
	}): Promise<ProjectMemberRecord | null> {
		const [row] = await this.database
			.update(projectMembers)
			.set({ role: input.role, updatedAt: new Date() })
			.where(
				and(
					eq(projectMembers.id, input.memberId),
					eq(projectMembers.projectId, input.projectId),
				),
			)
			.returning();
		return row
			? {
					id: row.id,
					projectId: row.projectId,
					userId: row.userId,
					role: row.role as ProjectMembershipRole,
					createdAt: row.createdAt,
					updatedAt: row.updatedAt,
				}
			: null;
	}

	async deleteProjectMember(input: {
		projectId: string;
		memberId: string;
	}): Promise<void> {
		await this.database
			.delete(projectMembers)
			.where(
				and(
					eq(projectMembers.id, input.memberId),
					eq(projectMembers.projectId, input.projectId),
				),
			);
	}
}

export class PostgresPieceCatalogRepository implements PieceCatalogRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getLatestPieceMetadata(pieceNameCandidates: string[]) {
		if (pieceNameCandidates.length === 0) return null;
		const [row] = await this.database
			.select({
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				description: pieceMetadata.description,
				logoUrl: pieceMetadata.logoUrl,
				categories: pieceMetadata.categories,
				version: pieceMetadata.version,
				auth: pieceMetadata.auth,
				actions: pieceMetadata.actions,
				availableOnly: pieceMetadata.availableOnly,
				catalogSourceImage: pieceMetadata.catalogSourceImage,
				catalogSyncedAt: pieceMetadata.catalogSyncedAt,
				updatedAt: pieceMetadata.updatedAt,
			})
			.from(pieceMetadata)
			.where(inArray(pieceMetadata.name, pieceNameCandidates))
			.orderBy(desc(pieceMetadata.updatedAt))
			.limit(1);
		return row ?? null;
	}

	async listConnectablePieces(input: {
		authOnly: boolean;
	}): Promise<ConnectablePieceRecord[]> {
		const whereClause = input.authOnly
			? sql`${pieceMetadata.availableOnly} = false AND ${pieceMetadata.auth} IS NOT NULL AND ${pieceMetadata.auth}->>'type' != 'NONE'`
			: sql`${pieceMetadata.availableOnly} = false`;
		const rows = await this.database
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
				authType: sql<string | null>`${pieceMetadata.auth}->>'type'`,
			})
			.from(pieceMetadata)
			.where(whereClause)
			.orderBy(pieceMetadata.name, pieceMetadata.displayName);
		return rows.map((row) => ({
			name: row.name,
			displayName: row.displayName,
			logoUrl: row.logoUrl,
			authType: row.authType ?? null,
		}));
	}

	async listPieceCatalogFunctions(): Promise<CatalogFunctionSummary[]> {
		const rows = await this.database
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
				description: pieceMetadata.description,
				version: pieceMetadata.version,
				auth: pieceMetadata.auth,
				actions: pieceMetadata.actions,
				categories: pieceMetadata.categories,
				catalogDigest: pieceMetadata.catalogDigest,
				catalogSourceImage: pieceMetadata.catalogSourceImage,
				availableOnly: pieceMetadata.availableOnly,
			})
			.from(pieceMetadata)
			.where(
				and(
					eq(pieceMetadata.catalogSchemaVersion, 1),
					eq(pieceMetadata.availableOnly, false),
				),
			)
			.orderBy(pieceMetadata.name, desc(pieceMetadata.catalogSyncedAt));
		return pieceCatalogFunctionsFromRows(rows);
	}

	listMcpCatalogPieces() {
		return this.database
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				description: pieceMetadata.description,
				logoUrl: pieceMetadata.logoUrl,
				categories: pieceMetadata.categories,
				auth: pieceMetadata.auth,
				actions: pieceMetadata.actions,
				availableOnly: pieceMetadata.availableOnly,
				updatedAt: pieceMetadata.updatedAt,
			})
			.from(pieceMetadata)
			.orderBy(pieceMetadata.name, desc(pieceMetadata.updatedAt));
	}

	async listConnectionUsageByPieceNames(input: {
		pieceNameCandidates: string[];
		projectId: string;
	}) {
		if (input.pieceNameCandidates.length === 0) return [];
		const rows = await this.database
			.select({
				connectionExternalId: workflowConnectionRefs.connectionExternalId,
				refCount: sql<number>`count(*)::int`,
				workflowCount: sql<number>`count(distinct ${workflowConnectionRefs.workflowId})::int`,
			})
			.from(workflowConnectionRefs)
			.innerJoin(workflows, eq(workflowConnectionRefs.workflowId, workflows.id))
			.where(
				and(
					inArray(workflowConnectionRefs.pieceName, input.pieceNameCandidates),
					eq(workflows.projectId, input.projectId),
				),
			)
			.groupBy(workflowConnectionRefs.connectionExternalId);
		return rows.map((row) => ({
			connectionExternalId: row.connectionExternalId,
			refCount: Number(row.refCount) || 0,
			workflowCount: Number(row.workflowCount) || 0,
		}));
	}
}

export class PostgresCodeFunctionCatalogRepository implements CodeFunctionCatalogRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listEnabledForCatalog(userId: string): Promise<CodeCatalogFunctionRecord[]> {
		const rows = await this.database
			.select({
				id: codeFunctions.id,
				name: codeFunctions.name,
				slug: codeFunctions.slug,
				description: codeFunctions.description,
				version: codeFunctions.version,
				latestPublishedVersion: codeFunctions.latestPublishedVersion,
				entrypoint: codeFunctions.entrypoint,
				language: codeFunctions.language,
			})
			.from(codeFunctions)
			.where(and(eq(codeFunctions.isEnabled, true), eq(codeFunctions.createdBy, userId)));
		return rows.map((row) => ({
			id: row.id,
			name: row.name,
			slug: row.slug,
			description: row.description,
			version: row.version,
			latestPublishedVersion: row.latestPublishedVersion,
			entrypoint: row.entrypoint,
			language: row.language,
		}));
	}
}

export class PostgresBenchmarkRunRepository implements BenchmarkRunRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getProjectId(runId: string): Promise<string | null> {
		const [run] = await this.database
			.select({ projectId: benchmarkRuns.projectId })
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, runId))
			.limit(1);
		return run?.projectId ?? null;
	}

	async getSessionProvisioningGate(input: {
		runId: string;
		instanceId?: string | null;
	}): Promise<BenchmarkSessionProvisioningGateRecord | null> {
		const [row] = await this.database
			.select({
				runStatus: benchmarkRuns.status,
				summary: benchmarkRuns.summary,
				instanceStatus: benchmarkRunInstances.status,
				inferenceStatus: benchmarkRunInstances.inferenceStatus,
			})
			.from(benchmarkRuns)
			.leftJoin(
				benchmarkRunInstances,
				and(
					eq(benchmarkRunInstances.runId, benchmarkRuns.id),
					input.instanceId
						? eq(benchmarkRunInstances.instanceId, input.instanceId)
						: eq(benchmarkRunInstances.runId, benchmarkRuns.id),
				),
			)
			.where(eq(benchmarkRuns.id, input.runId))
			.limit(1);
		if (!row) return null;
		return {
			runStatus: row.runStatus,
			summary: isRecord(row.summary) ? row.summary : null,
			instanceStatus: row.instanceStatus ?? null,
			inferenceStatus: row.inferenceStatus ?? null,
		};
	}
}

export class PostgresBenchmarkArtifactMetadataRepository
	implements BenchmarkArtifactMetadataRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async recordArtifact(input: BenchmarkArtifactMetadataInput): Promise<void> {
		let runInstanceId: string | null = null;
		if (input.instanceId) {
			const [row] = await this.database
				.select({ id: benchmarkRunInstances.id })
				.from(benchmarkRunInstances)
				.where(
					and(
						eq(benchmarkRunInstances.runId, input.runId),
						eq(benchmarkRunInstances.instanceId, input.instanceId),
					),
				)
				.limit(1);
			runInstanceId = row?.id ?? null;
		}

		await this.database.insert(benchmarkArtifacts).values({
			runId: input.runId,
			runInstanceId,
			kind: input.kind,
			path: input.path,
			contentType: input.contentType,
			sizeBytes: input.sizeBytes,
			sha256: input.sha256,
			metadata: input.metadata,
		});
	}
}

export class PostgresBenchmarkEvaluationResultRepository
	implements BenchmarkEvaluationResultRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getRunForEvaluationIngestion(
		runId: string,
	): Promise<BenchmarkEvaluationRunRecord | null> {
		return this.getRun(runId);
	}

	async loadPatchContexts(
		runId: string,
	): Promise<Map<string, BenchmarkEvaluationPatchContext>> {
		const rows = await this.database
			.select({
				instanceId: benchmarkRunInstances.instanceId,
				modelPatch: benchmarkRunInstances.modelPatch,
				goldPatch: benchmarkInstances.goldPatch,
			})
			.from(benchmarkRunInstances)
			.leftJoin(
				benchmarkInstances,
				eq(benchmarkInstances.id, benchmarkRunInstances.benchmarkInstanceId),
			)
			.where(eq(benchmarkRunInstances.runId, runId));
		const map = new Map<string, BenchmarkEvaluationPatchContext>();
		for (const row of rows) {
			map.set(row.instanceId, {
				modelPatch: row.modelPatch,
				goldPatch: row.goldPatch,
			});
		}
		return map;
	}

	async batchUpdateEvaluationResults(input: {
		runId: string;
		updates: BenchmarkEvaluationResultUpdate[];
		evaluatedAt: Date;
	}): Promise<void> {
		if (input.updates.length === 0) return;
		const updates = input.updates.map((update) => ({
			instance_id: update.instanceId,
			status: update.status,
			evaluation_status: update.evaluationStatus,
			error: update.error,
			evaluation_error: update.evaluationError,
			logs_path: update.logsPath,
			test_output_summary: update.testOutputSummary,
			harness_result: update.harnessResult,
			patch_added_lines: update.patchAddedLines,
			patch_removed_lines: update.patchRemovedLines,
			patch_files_touched: update.patchFilesTouched,
			patch_files_overlap_gold: update.patchFilesOverlapGold,
			patch_well_formed: update.patchWellFormed,
		}));
		await this.database.execute(sql`
			UPDATE benchmark_run_instances AS b
			SET status = u.status,
			    evaluation_status = u.evaluation_status,
			    error = u.error,
			    evaluation_error = u.evaluation_error,
			    logs_path = u.logs_path,
			    test_output_summary = u.test_output_summary,
			    harness_result = u.harness_result,
			    patch_added_lines = u.patch_added_lines,
			    patch_removed_lines = u.patch_removed_lines,
			    patch_files_touched = u.patch_files_touched,
			    patch_files_overlap_gold = u.patch_files_overlap_gold,
			    patch_well_formed = u.patch_well_formed,
			    evaluated_at = ${input.evaluatedAt},
			    updated_at = now()
			FROM jsonb_to_recordset((${JSON.stringify(updates)})::text::jsonb)
			     AS u(
			       instance_id text,
			       status text,
			       evaluation_status text,
			       error text,
			       evaluation_error text,
			       logs_path text,
			       test_output_summary text,
			       harness_result jsonb,
			       patch_added_lines integer,
			       patch_removed_lines integer,
			       patch_files_touched integer,
			       patch_files_overlap_gold integer,
			       patch_well_formed boolean
			     )
			WHERE b.run_id = ${input.runId} AND b.instance_id = u.instance_id
		`);
	}

	async countActiveEvaluationRows(runId: string): Promise<number> {
		const [row] = await this.database
			.select({ value: count() })
			.from(benchmarkRunInstances)
			.where(
				and(
					eq(benchmarkRunInstances.runId, runId),
					inArray(benchmarkRunInstances.status, [
						"queued",
						"inferencing",
						"inferred",
						"evaluating",
					]),
				),
			);
		return Number(row?.value ?? 0);
	}

	async getRunForResponse(runId: string): Promise<BenchmarkEvaluationRunRecord | null> {
		return this.getRun(runId);
	}

	private async getRun(runId: string): Promise<BenchmarkEvaluationRunRecord | null> {
		const [row] = await this.database
			.select()
			.from(benchmarkRuns)
			.where(eq(benchmarkRuns.id, runId))
			.limit(1);
		return (row as BenchmarkEvaluationRunRecord | undefined) ?? null;
	}
}

export class PostgresBenchmarkBrowserRepository implements BenchmarkBrowserRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async ensureDefaultSuites(): Promise<void> {
		for (const suite of SWEBENCH_SUITES) {
			await this.database
				.insert(benchmarkSuites)
				.values({
					id: suite.id,
					slug: suite.slug,
					name: suite.name,
					description: suite.description,
					datasetName: suite.datasetName,
					datasetSplit: suite.datasetSplit,
					sourceUrl: suite.sourceUrl,
					defaultInstanceLimit: suite.defaultInstanceLimit,
					metadata: suite.metadata,
				})
				.onConflictDoUpdate({
					target: benchmarkSuites.slug,
					set: {
						name: suite.name,
						description: suite.description,
						datasetName: suite.datasetName,
						datasetSplit: suite.datasetSplit,
						sourceUrl: suite.sourceUrl,
						defaultInstanceLimit: suite.defaultInstanceLimit,
						metadata: suite.metadata,
						updatedAt: new Date(),
					},
				});
		}
	}

	listInstances() {
		return this.database
			.select({
				id: benchmarkInstances.id,
				instanceId: benchmarkInstances.instanceId,
				repo: benchmarkInstances.repo,
				baseCommit: benchmarkInstances.baseCommit,
				problemStatement: benchmarkInstances.problemStatement,
				hintsText: benchmarkInstances.hintsText,
				testMetadata: benchmarkInstances.testMetadata,
				suiteSlug: benchmarkSuites.slug,
				suiteName: benchmarkSuites.name,
				datasetName: benchmarkSuites.datasetName,
			})
			.from(benchmarkInstances)
			.innerJoin(
				benchmarkSuites,
				eq(benchmarkInstances.suiteId, benchmarkSuites.id),
			)
			.orderBy(asc(benchmarkInstances.instanceId));
	}

	listRepoFacets() {
		return this.database
			.select({
				repo: benchmarkInstances.repo,
				count: count(),
			})
			.from(benchmarkInstances)
			.groupBy(benchmarkInstances.repo);
	}

	listSuites() {
		return this.database
			.select({
				id: benchmarkSuites.id,
				slug: benchmarkSuites.slug,
				name: benchmarkSuites.name,
			})
			.from(benchmarkSuites)
			.orderBy(asc(benchmarkSuites.name));
	}

	listEnvironmentBuilds() {
		return this.database
			.select({
				envSpecHash: environmentImageBuilds.envSpecHash,
				environmentKey: environmentImageBuilds.environmentKey,
				status: environmentImageBuilds.status,
				validationStatus: environmentImageBuilds.validationStatus,
				sandboxImage: environmentImageBuilds.sandboxImage,
				digest: environmentImageBuilds.digest,
			})
			.from(environmentImageBuilds)
			.orderBy(desc(environmentImageBuilds.updatedAt));
	}

	listRunnableAgentCandidates(input: { projectId: string | null }) {
		if (!input.projectId) {
			return Promise.resolve([]);
		}
		return this.database
			.select({
				id: agents.id,
				slug: agents.slug,
				name: agents.name,
				avatar: agents.avatar,
				runtime: agents.runtime,
				registryStatus: agents.registryStatus,
				currentVersionId: agents.currentVersionId,
				runtimeAppId: agents.runtimeAppId,
				versionNumber: agentVersions.version,
				config: agentVersions.config,
			})
			.from(agents)
			.leftJoin(agentVersions, eq(agentVersions.id, agents.currentVersionId))
			.where(
				and(
					eq(agents.projectId, input.projectId),
					eq(agents.isArchived, false),
					inArray(agents.runtime, [...BENCHMARK_AGENT_RUNTIMES]),
					eq(agents.registryStatus, "registered"),
					sql`NOT (${agents.tags} @> '["workflow-ephemeral"]'::jsonb)`,
				),
			)
			.orderBy(asc(agents.name));
	}
}

export class PostgresBenchmarkInstanceDetailReadRepository
	implements BenchmarkInstanceDetailReadRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getBenchmarkInstanceDetail(input: {
		suiteSlug: string;
		instanceId: string;
	}) {
		const suiteSlug = input.suiteSlug.trim();
		const instanceId = input.instanceId.trim();
		if (!suiteSlug || !instanceId) return null;

		const [row] = await this.database
			.select({
				id: benchmarkInstances.id,
				instanceId: benchmarkInstances.instanceId,
				repo: benchmarkInstances.repo,
				baseCommit: benchmarkInstances.baseCommit,
				problemStatement: benchmarkInstances.problemStatement,
				hintsText: benchmarkInstances.hintsText,
				testMetadata: benchmarkInstances.testMetadata,
				goldPatch: benchmarkInstances.goldPatch,
				metadata: benchmarkInstances.metadata,
				suiteSlug: benchmarkSuites.slug,
				suiteName: benchmarkSuites.name,
			})
			.from(benchmarkInstances)
			.innerJoin(
				benchmarkSuites,
				eq(benchmarkInstances.suiteId, benchmarkSuites.id),
			)
			.where(
				and(
					eq(benchmarkSuites.slug, suiteSlug),
					eq(benchmarkInstances.instanceId, instanceId),
				),
			)
			.limit(1);
		if (!row) return null;

		return {
			...row,
			testMetadata: isRecord(row.testMetadata) ? row.testMetadata : {},
			metadata: isRecord(row.metadata) ? row.metadata : null,
		};
	}
}

export class PostgresBenchmarkRunInstanceScoreReadRepository
	implements BenchmarkRunInstanceScoreReadRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listRunInstanceScores(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}) {
		const runId = input.runId.trim();
		const instanceId = input.instanceId.trim();
		const projectId = input.projectId.trim();
		if (!runId || !instanceId || !projectId) return { status: "run_not_found" as const };

		const [runRow] = await this.database
			.select({ id: benchmarkRuns.id })
			.from(benchmarkRuns)
			.where(
				and(
					eq(benchmarkRuns.id, runId),
					eq(benchmarkRuns.projectId, projectId),
				),
			)
			.limit(1);
		if (!runRow) return { status: "run_not_found" as const };

		const [instance] = await this.database
			.select({ id: benchmarkRunInstances.id })
			.from(benchmarkRunInstances)
			.where(
				and(
					eq(benchmarkRunInstances.runId, runId),
					eq(benchmarkRunInstances.instanceId, instanceId),
				),
			)
			.limit(1);
		if (!instance) return { status: "instance_not_found" as const };

		const rows = await this.database
			.select({
				id: benchmarkRunInstanceScores.id,
				scorerName: benchmarkRunInstanceScores.scorerName,
				scorerVersion: benchmarkRunInstanceScores.scorerVersion,
				score: benchmarkRunInstanceScores.score,
				reasoning: benchmarkRunInstanceScores.reasoning,
				metadata: benchmarkRunInstanceScores.metadata,
				createdAt: benchmarkRunInstanceScores.createdAt,
			})
			.from(benchmarkRunInstanceScores)
			.where(eq(benchmarkRunInstanceScores.runInstanceId, instance.id))
			.orderBy(asc(benchmarkRunInstanceScores.scorerName));

		return {
			status: "ok" as const,
			scores: rows.map((row) => ({
				...row,
				metadata: isRecord(row.metadata) ? row.metadata : {},
			})),
		};
	}
}

export class PostgresBenchmarkRunInstanceDetailReadRepository
	implements BenchmarkRunInstanceDetailReadRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getRunInstanceDetail(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}) {
		const runId = input.runId.trim();
		const instanceId = input.instanceId.trim();
		const projectId = input.projectId.trim();
		if (!runId || !instanceId || !projectId) return { status: "run_not_found" as const };

		const [runRow] = await this.database
			.select({
				id: benchmarkRuns.id,
				suiteId: benchmarkRuns.suiteId,
				mlflowExperimentId: benchmarkRuns.mlflowExperimentId,
			})
			.from(benchmarkRuns)
			.where(
				and(
					eq(benchmarkRuns.id, runId),
					eq(benchmarkRuns.projectId, projectId),
				),
			)
			.limit(1);
		if (!runRow) return { status: "run_not_found" as const };

		const [row] = await this.database
			.select({
				run: benchmarkRunInstances,
				goldPatch: benchmarkInstances.goldPatch,
				problemStatement: benchmarkInstances.problemStatement,
				hintsText: benchmarkInstances.hintsText,
				testMetadata: benchmarkInstances.testMetadata,
				repo: benchmarkInstances.repo,
				baseCommit: benchmarkInstances.baseCommit,
				instanceMetadata: benchmarkInstances.metadata,
				executionIr: workflowExecutions.executionIr,
				executionOutput: workflowExecutions.output,
			})
			.from(benchmarkRunInstances)
			.leftJoin(
				benchmarkInstances,
				and(
					eq(benchmarkInstances.suiteId, runRow.suiteId),
					eq(benchmarkInstances.instanceId, benchmarkRunInstances.instanceId),
				),
			)
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, benchmarkRunInstances.workflowExecutionId),
			)
			.where(
				and(
					eq(benchmarkRunInstances.runId, runId),
					eq(benchmarkRunInstances.instanceId, instanceId),
				),
			)
			.limit(1);
		if (!row) return { status: "instance_not_found" as const };

		return {
			status: "ok" as const,
			mlflowExperimentId: runRow.mlflowExperimentId,
			runInstance: {
				...row.run,
				traceIds: Array.isArray(row.run.traceIds)
					? row.run.traceIds.filter((item): item is string => typeof item === "string")
					: null,
			},
			instance: {
				repo: row.repo,
				baseCommit: row.baseCommit,
				problemStatement: row.problemStatement,
				hintsText: row.hintsText,
				testMetadata: isRecord(row.testMetadata) ? row.testMetadata : {},
				metadata: isRecord(row.instanceMetadata) ? row.instanceMetadata : null,
				goldPatch: row.goldPatch,
			},
			executionIr: row.executionIr,
			executionOutput: row.executionOutput,
		};
	}
}

export class PostgresBenchmarkRunInstanceProgressReadRepository
	implements BenchmarkRunInstanceProgressReadRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getRunInstanceProgress(input: {
		runId: string;
		instanceId: string;
		now: Date;
	}) {
		const [instance] = await this.database
			.select({
				id: benchmarkRunInstances.id,
				status: benchmarkRunInstances.status,
				inferenceStatus: benchmarkRunInstances.inferenceStatus,
				evaluationStatus: benchmarkRunInstances.evaluationStatus,
				sessionId: benchmarkRunInstances.sessionId,
				updatedAt: benchmarkRunInstances.updatedAt,
			})
			.from(benchmarkRunInstances)
			.where(
				and(
					eq(benchmarkRunInstances.runId, input.runId),
					eq(benchmarkRunInstances.instanceId, input.instanceId),
				),
			)
			.limit(1);
		if (!instance) return { status: "not_found" as const };

		const [latestEvent] = instance.sessionId
			? await this.database
					.select({
						sequence: sessionEvents.sequence,
						type: sessionEvents.type,
						createdAt: sessionEvents.createdAt,
					})
					.from(sessionEvents)
					.where(eq(sessionEvents.sessionId, instance.sessionId))
					.orderBy(desc(sessionEvents.sequence))
					.limit(1)
			: [];
		const latestActivityAt = latestEvent?.createdAt ?? instance.updatedAt;
		const activityAgeSeconds = Math.max(
			0,
			Math.floor((input.now.getTime() - latestActivityAt.getTime()) / 1000),
		);

		return {
			status: "ok" as const,
			runInstanceStatus: instance.status,
			inferenceStatus: instance.inferenceStatus,
			evaluationStatus: instance.evaluationStatus,
			sessionId: instance.sessionId,
			latestSessionEventType: latestEvent?.type ?? null,
			latestSessionEventSequence: latestEvent?.sequence ?? null,
			latestActivityAt,
			activityAgeSeconds,
			progressMarker: [
				instance.status,
				instance.inferenceStatus,
				instance.evaluationStatus,
				instance.updatedAt.toISOString(),
				latestEvent?.sequence ?? "no-session-event",
				latestEvent?.createdAt.toISOString() ?? "no-session-event",
			].join(":"),
		};
	}
}

export class PostgresBenchmarkDatasetPromotionRepository
	implements BenchmarkDatasetPromotionRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async promoteRunInstanceToDataset(input: {
		projectId: string;
		datasetId: string;
		runId: string;
		instanceId: string;
		now: Date;
	}) {
		const [source] = await this.database
			.select({
				runInstance: benchmarkRunInstances,
				suiteId: benchmarkRuns.suiteId,
				projectId: benchmarkRuns.projectId,
				problemStatement: benchmarkInstances.problemStatement,
				repo: benchmarkInstances.repo,
				baseCommit: benchmarkInstances.baseCommit,
				hintsText: benchmarkInstances.hintsText,
			})
			.from(benchmarkRunInstances)
			.innerJoin(benchmarkRuns, eq(benchmarkRuns.id, benchmarkRunInstances.runId))
			.leftJoin(
				benchmarkInstances,
				and(
					eq(benchmarkInstances.suiteId, benchmarkRuns.suiteId),
					eq(
						benchmarkInstances.instanceId,
						benchmarkRunInstances.instanceId,
					),
				),
			)
			.where(
				and(
					eq(benchmarkRunInstances.runId, input.runId),
					eq(benchmarkRunInstances.instanceId, input.instanceId),
				),
			)
			.limit(1);

		if (!source) return { status: "benchmark_instance_not_found" as const };
		if (source.projectId !== input.projectId) {
			return { status: "run_in_different_workspace" as const };
		}

		const [dataset] = await this.database
			.select({ id: evaluationDatasets.id })
			.from(evaluationDatasets)
			.where(
				and(
					eq(evaluationDatasets.projectId, input.projectId),
					eq(evaluationDatasets.id, input.datasetId),
				),
			)
			.limit(1);
		if (!dataset) return { status: "evaluation_dataset_not_found" as const };

		const [inserted] = await this.database
			.insert(evaluationDatasetRows)
			.values({
				datasetId: input.datasetId,
				externalId: input.instanceId,
				input: {
					instance_id: input.instanceId,
					repo: source.repo,
					base_commit: source.baseCommit,
					problem_statement: source.problemStatement,
					hints_text: source.hintsText,
				},
				expectedOutput: {
					harness_resolved: source.runInstance.status === "resolved",
					patch_files_overlap_gold: source.runInstance.patchFilesOverlapGold,
					patch_well_formed: source.runInstance.patchWellFormed,
					patch_added_lines: source.runInstance.patchAddedLines,
					patch_removed_lines: source.runInstance.patchRemovedLines,
				},
				metadata: {
					promotedFromRunId: input.runId,
					promotedAt: input.now.toISOString(),
					suiteId: source.suiteId,
				},
				originRunInstanceId: source.runInstance.id,
				originSessionId: source.runInstance.sessionId,
			})
			.returning();

		return {
			status: "ok" as const,
			rows: [
				{
					id: inserted.id,
					datasetId: inserted.datasetId,
					externalId: inserted.externalId,
					input: inserted.input,
					expectedOutput: inserted.expectedOutput,
					generatedOutput: inserted.generatedOutput,
					annotations: inserted.annotations,
					rating: inserted.rating,
					feedback: inserted.feedback,
					metadata: inserted.metadata,
					originRunInstanceId: inserted.originRunInstanceId,
					originSessionId: inserted.originSessionId,
					createdAt: inserted.createdAt,
					updatedAt: inserted.updatedAt,
				},
			],
		};
	}
}

export class PostgresBenchmarkRunInstanceAnnotationRepository
	implements BenchmarkRunInstanceAnnotationRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	private async resolveRunInstanceId(input: {
		runId: string;
		instanceId: string;
		projectId: string;
	}): Promise<string | null> {
		const runId = input.runId.trim();
		const instanceId = input.instanceId.trim();
		const projectId = input.projectId.trim();
		if (!runId || !instanceId || !projectId) return null;

		const [runRow] = await this.database
			.select({ id: benchmarkRuns.id })
			.from(benchmarkRuns)
			.where(
				and(
					eq(benchmarkRuns.id, runId),
					eq(benchmarkRuns.projectId, projectId),
				),
			)
			.limit(1);
		if (!runRow) return null;

		const [instance] = await this.database
			.select({ id: benchmarkRunInstances.id })
			.from(benchmarkRunInstances)
			.where(
				and(
					eq(benchmarkRunInstances.runId, runId),
					eq(benchmarkRunInstances.instanceId, instanceId),
				),
			)
			.limit(1);
		return instance?.id ?? null;
	}

	async getRunInstanceAnnotations(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}) {
		const runInstanceId = await this.resolveRunInstanceId(input);
		if (!runInstanceId) return { status: "not_found" as const };

		const [my] = await this.database
			.select({
				verdict: benchmarkRunInstanceAnnotations.verdict,
				reasoning: benchmarkRunInstanceAnnotations.reasoning,
				updatedAt: benchmarkRunInstanceAnnotations.updatedAt,
			})
			.from(benchmarkRunInstanceAnnotations)
			.where(
				and(
					eq(benchmarkRunInstanceAnnotations.runInstanceId, runInstanceId),
					eq(benchmarkRunInstanceAnnotations.userId, input.userId),
				),
			)
			.limit(1);

		const aggregateRows = await this.database
			.select({
				verdict: benchmarkRunInstanceAnnotations.verdict,
				count: sql<number>`count(*)::int`,
			})
			.from(benchmarkRunInstanceAnnotations)
			.where(eq(benchmarkRunInstanceAnnotations.runInstanceId, runInstanceId))
			.groupBy(benchmarkRunInstanceAnnotations.verdict);
		const counts = emptyBenchmarkAnnotationCounts();
		for (const row of aggregateRows) {
			if (isBenchmarkAnnotationVerdict(row.verdict)) {
				counts[row.verdict] = Number(row.count);
			}
		}

		return {
			status: "ok" as const,
			mine:
				my && isBenchmarkAnnotationVerdict(my.verdict)
					? {
							verdict: my.verdict,
							reasoning: my.reasoning,
							updatedAt: my.updatedAt,
						}
					: null,
			counts,
		};
	}

	async upsertRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
		verdict: BenchmarkInstanceAnnotationVerdict;
		reasoning: string | null;
	}) {
		const runInstanceId = await this.resolveRunInstanceId(input);
		if (!runInstanceId) return { status: "not_found" as const };

		await this.database
			.insert(benchmarkRunInstanceAnnotations)
			.values({
				runInstanceId,
				userId: input.userId,
				verdict: input.verdict,
				reasoning: input.reasoning,
			})
			.onConflictDoUpdate({
				target: [
					benchmarkRunInstanceAnnotations.runInstanceId,
					benchmarkRunInstanceAnnotations.userId,
				],
				set: {
					verdict: input.verdict,
					reasoning: input.reasoning,
					updatedAt: new Date(),
				},
			});

		return { status: "ok" as const };
	}

	async deleteRunInstanceAnnotation(input: {
		runId: string;
		instanceId: string;
		projectId: string;
		userId: string;
	}) {
		const runInstanceId = await this.resolveRunInstanceId(input);
		if (!runInstanceId) return { status: "not_found" as const };

		await this.database
			.delete(benchmarkRunInstanceAnnotations)
			.where(
				and(
					eq(benchmarkRunInstanceAnnotations.runInstanceId, runInstanceId),
					eq(benchmarkRunInstanceAnnotations.userId, input.userId),
				),
			);

		return { status: "ok" as const };
	}
}

export class PostgresWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getById(id: string): Promise<WorkflowDefinition | null> {
		const [row] = await this.database
			.select()
			.from(workflows)
			.where(eq(workflows.id, id))
			.limit(1);
		return row ? mapWorkflow(row) : null;
	}

	async getLatestByName(name: string): Promise<WorkflowDefinition | null> {
		const candidates = await this.database
			.select()
			.from(workflows)
			.where(eq(workflows.name, name))
			.orderBy(desc(workflows.updatedAt))
			.limit(20);
		if (candidates.length === 0) return null;
		const row = candidates.find((workflow) => workflow.visibility === "public") ?? candidates[0] ?? null;
		return row ? mapWorkflow(row) : null;
	}

	async getByRef(ref: { workflowId?: string | null; workflowName?: string | null }): Promise<WorkflowDefinition | null> {
		const workflowId = ref.workflowId?.trim();
		if (workflowId) return this.getById(workflowId);
		const workflowName = ref.workflowName?.trim();
		if (!workflowName) return null;
		return this.getLatestByName(workflowName);
	}

	async list(input: {
		limit: number;
		projectId?: string | null;
	}): Promise<WorkflowDefinitionListItem[]> {
		const limit = Number.isFinite(input.limit) ? Math.max(1, input.limit) : 50;
		let query = this.database
			.select({
				id: workflows.id,
				name: workflows.name,
				engineType: workflows.engineType,
				createdAt: workflows.createdAt,
				updatedAt: workflows.updatedAt,
			})
			.from(workflows)
			.$dynamic();
		if (input.projectId) {
			query = query.where(eq(workflows.projectId, input.projectId));
		}
		return query.orderBy(desc(workflows.updatedAt)).limit(limit);
	}

	async listForWorkspace(input: {
		limit: number;
		userId: string;
		projectId?: string | null;
	}) {
		const limit = Number.isFinite(input.limit) ? Math.max(1, input.limit) : 100;
		return this.database
			.select({
				id: workflows.id,
				name: workflows.name,
				updatedAt: workflows.updatedAt,
			})
			.from(workflows)
			.where(
				input.projectId
					? or(
							eq(workflows.projectId, input.projectId),
							and(isNull(workflows.projectId), eq(workflows.userId, input.userId)),
						)
					: eq(workflows.userId, input.userId),
			)
			.orderBy(desc(workflows.updatedAt))
			.limit(limit);
	}

	async findProjectWorkflowIdByIdOrNamePrefix(input: {
		projectId: string;
		workflowId: string;
		namePrefix: string;
	}): Promise<string | null> {
		const [row] = await this.database
			.select({ id: workflows.id })
			.from(workflows)
			.where(
				and(
					eq(workflows.projectId, input.projectId),
					or(
						eq(workflows.id, input.workflowId),
						like(workflows.name, input.namePrefix),
					),
				),
			)
			.limit(1);
		return row?.id ?? null;
	}

	async create(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition> {
		const [row] = await this.database
			.insert(workflows)
			.values({
				name: input.name,
				nodes: input.nodes,
				edges: input.edges,
				engineType: input.engineType,
				userId: input.userId,
				projectId: input.projectId,
				...(input.spec !== undefined ? { spec: input.spec } : {}),
			})
			.returning();
		if (!row) throw new Error("Failed to create workflow");
		return mapWorkflow(row);
	}

	async update(
		id: string,
		input: UpdateWorkflowDefinitionInput,
	): Promise<WorkflowDefinition | null> {
		const values: Record<string, unknown> = { updatedAt: new Date() };
		if (input.name !== undefined) values.name = input.name;
		if (input.nodes !== undefined) values.nodes = input.nodes;
		if (input.edges !== undefined) values.edges = input.edges;
		if (input.spec !== undefined) values.spec = input.spec;
		if (input.daprWorkflowName !== undefined) values.daprWorkflowName = input.daprWorkflowName;
		const [row] = await this.database
			.update(workflows)
			.set(values)
			.where(eq(workflows.id, id))
			.returning();
		return row ? mapWorkflow(row) : null;
	}

	async hasActiveExecutions(id: string): Promise<boolean> {
		const rows = await this.database
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(
				and(
					eq(workflowExecutions.workflowId, id),
					inArray(workflowExecutions.status, ["pending", "running"]),
				),
			)
			.limit(1);
		return rows.length > 0;
	}

	async delete(id: string): Promise<void> {
		await this.database.delete(workflows).where(eq(workflows.id, id));
	}
}

export class PostgresModelCatalogRepository implements ModelCatalogRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listEnabledModelIds(): Promise<string[]> {
		const rows = await this.database
			.select({ id: modelCatalog.id })
			.from(modelCatalog)
			.where(eq(modelCatalog.isEnabled, true));
		return rows.map((row) => row.id);
	}
}

export class PostgresWorkflowTriggerStore implements WorkflowTriggerStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listByWorkflowId(workflowId: string): Promise<WorkflowTriggerRecord[]> {
		const rows = await this.database
			.select()
			.from(workflowTriggers)
			.where(eq(workflowTriggers.workflowId, workflowId))
			.orderBy(desc(workflowTriggers.createdAt));
		return rows.map(mapTrigger);
	}

	async create(input: CreateWorkflowTriggerInput): Promise<WorkflowTriggerRecord> {
		const [row] = await this.database
			.insert(workflowTriggers)
			.values({
				workflowId: input.workflowId,
				userId: input.userId,
				projectId: input.projectId,
				kind: input.kind,
				config: input.config,
				triggerData: input.triggerData ?? null,
				dedupSalt: input.dedupSalt,
				status: input.status ?? "inactive",
			})
			.returning();
		if (!row) throw new Error("Failed to create workflow trigger");
		return mapTrigger(row);
	}

	async getById(triggerId: string): Promise<WorkflowTriggerRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowTriggers)
			.where(eq(workflowTriggers.id, triggerId))
			.limit(1);
		return row ? mapTrigger(row) : null;
	}

	async getForWorkflow(input: {
		workflowId: string;
		triggerId: string;
	}): Promise<WorkflowTriggerRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowTriggers)
			.where(
				and(
					eq(workflowTriggers.id, input.triggerId),
					eq(workflowTriggers.workflowId, input.workflowId),
				),
			)
			.limit(1);
		return row ? mapTrigger(row) : null;
	}

	async markFired(input: { triggerId: string; firedAt: Date }): Promise<void> {
		await this.database
			.update(workflowTriggers)
			.set({ lastFiredAt: input.firedAt })
			.where(eq(workflowTriggers.id, input.triggerId));
	}

	async delete(triggerId: string): Promise<void> {
		await this.database.delete(workflowTriggers).where(eq(workflowTriggers.id, triggerId));
	}
}

export class PostgresPieceExecutionRepository implements PieceExecutionRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getByIdempotencyKey(idempotencyKey: string): Promise<PieceExecutionReadModel | null> {
		const [row] = await this.database
			.select()
			.from(pieceExecution)
			.where(eq(pieceExecution.idempotencyKey, idempotencyKey))
			.limit(1);
		if (!row) return null;
		return {
			idempotencyKey: row.idempotencyKey,
			status: row.status,
			result: row.result,
			error: row.error,
			pieceName: row.pieceName,
			actionName: row.actionName,
			completedAt:
				row.status === "completed" || row.status === "failed"
					? row.updatedAt
					: null,
		};
	}
}

const BROWSER_ARTIFACT_BLOB_PREFIX = "workflow-browser-artifacts";

function browserArtifactContentType(asset: WorkflowBrowserArtifactAssetInput): string {
	if (asset.contentType?.trim()) return asset.contentType.trim();
	if (asset.kind === "trace") return "application/zip";
	if (asset.kind === "video" || asset.kind === "video-annotated") return "video/webm";
	if (asset.kind === "caption") return "text/vtt; charset=utf-8";
	return "image/png";
}

function browserArtifactExtension(contentType: string, fileName?: string): string {
	if (fileName?.includes(".")) return fileName.split(".").pop() || "bin";
	if (contentType === "application/zip") return "zip";
	if (contentType.startsWith("text/vtt")) return "vtt";
	if (contentType.startsWith("video/")) return "webm";
	if (contentType === "image/jpeg") return "jpg";
	return "png";
}

function browserArtifactStorageRef(input: {
	workflowExecutionId: string;
	artifactId: string;
	kind: string;
	index: number;
	contentType: string;
	fileName?: string;
}): string {
	const safeExecution = input.workflowExecutionId.replace(/[^a-zA-Z0-9._-]/g, "-");
	const ext = browserArtifactExtension(input.contentType, input.fileName);
	return `${BROWSER_ARTIFACT_BLOB_PREFIX}/${safeExecution}/${input.artifactId}/${input.kind}-${input.index + 1}.${ext}`;
}

function browserArtifactStep(input: WorkflowBrowserCaptureStepInput, index: number) {
	return {
		id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : `step-${index + 1}`,
		label:
			typeof input.label === "string" && input.label.trim()
				? input.label.trim()
				: `Step ${index + 1}`,
		url: typeof input.url === "string" ? input.url : "",
		...(typeof input.action === "string" && input.action.trim()
			? { action: input.action.trim() }
			: {}),
		...(typeof input.goal === "string" && input.goal.trim()
			? { goal: input.goal.trim() }
			: {}),
		...(typeof input.title === "string" && input.title.trim()
			? { title: input.title.trim() }
			: {}),
		...(typeof input.waitForSelector === "string" && input.waitForSelector.trim()
			? { waitForSelector: input.waitForSelector.trim() }
			: {}),
		...(typeof input.waitForText === "string" && input.waitForText.trim()
			? { waitForText: input.waitForText.trim() }
			: {}),
		...(typeof input.delayMs === "number" && Number.isFinite(input.delayMs)
			? { delayMs: input.delayMs }
			: {}),
		...(typeof input.pauseMs === "number" && Number.isFinite(input.pauseMs)
			? { pauseMs: input.pauseMs }
			: {}),
		...(typeof input.successCriteria === "string" && input.successCriteria.trim()
			? { successCriteria: input.successCriteria.trim() }
			: {}),
		...(typeof input.capturedAt === "string" && input.capturedAt.trim()
			? { capturedAt: input.capturedAt.trim() }
			: {}),
		status: input.status === "failed" ? "failed" : "completed",
		...(typeof input.screenshotStorageRef === "string" && input.screenshotStorageRef.trim()
			? { screenshotStorageRef: input.screenshotStorageRef.trim() }
			: {}),
		...(typeof input.error === "string" && input.error.trim()
			? { error: input.error.trim() }
			: {}),
	};
}

function toWorkflowBrowserArtifactRecord(
	row: typeof workflowBrowserArtifacts.$inferSelect,
): WorkflowBrowserArtifactRecord {
	return {
		id: row.id,
		workflowExecutionId: row.workflowExecutionId,
		workflowId: row.workflowId,
		nodeId: row.nodeId,
		workspaceRef: row.workspaceRef,
		artifactType: row.artifactType,
		artifactVersion: row.artifactVersion,
		status: row.status,
		manifestJson: (row.manifestJson ?? {}) as Record<string, unknown>,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export class PostgresWorkflowBrowserArtifactStore implements WorkflowBrowserArtifactStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async save(input: SaveWorkflowBrowserArtifactInput): Promise<WorkflowBrowserArtifactRecord> {
		const artifactId = `bwf_${nanoid(12)}`;
		const now = new Date().toISOString();
		const steps = input.steps.map((step, index) => browserArtifactStep(step, index));
		const manifest: Record<string, unknown> = {
			baseUrl: input.baseUrl,
			startedAt: now,
			completedAt: new Date().toISOString(),
			status: input.status,
			steps,
			assets: [],
			metadata: input.metadata ?? null,
		};
		const screenshotAssets = (input.screenshots ?? []).map((asset) => ({
			...asset,
			kind: "screenshot" as const,
		}));
		const allAssets: WorkflowBrowserArtifactAssetInput[] = [
			...screenshotAssets,
			...(input.assets ?? []),
		];
		const manifestAssets = manifest.assets as Array<Record<string, unknown>>;
		for (const [index, asset] of allAssets.entries()) {
			const contentType = browserArtifactContentType(asset);
			const storageRef =
				asset.storageRef ||
				browserArtifactStorageRef({
					workflowExecutionId: input.workflowExecutionId,
					artifactId,
					kind: asset.kind,
					index,
					contentType,
					fileName: asset.fileName,
				});
			await this.database
				.insert(workflowBrowserArtifactBlobPayloads)
				.values({
					storageRef,
					payloadText: asset.payloadBase64,
					contentType,
				})
				.onConflictDoUpdate({
					target: workflowBrowserArtifactBlobPayloads.storageRef,
					set: {
						payloadText: asset.payloadBase64,
						contentType,
					},
				});
			if (asset.kind === "screenshot") {
				const stepIndex = steps.findIndex((step) => step.id === asset.stepId);
				if (stepIndex >= 0 && !("screenshotStorageRef" in steps[stepIndex])) {
					steps[stepIndex].screenshotStorageRef = storageRef;
				}
			}
			manifestAssets.push({
				kind: asset.kind,
				label: asset.label,
				storageRef,
				contentType,
				...(asset.fileName ? { fileName: asset.fileName } : {}),
				...(asset.stepId ? { stepId: asset.stepId } : {}),
			});
		}
		const [row] = await this.database
			.insert(workflowBrowserArtifacts)
			.values({
				id: artifactId,
				workflowExecutionId: input.workflowExecutionId,
				workflowId: input.workflowId,
				nodeId: input.nodeId,
				workspaceRef: input.workspaceRef ?? null,
				artifactType: "capture_flow_v1",
				artifactVersion: 1,
				status: input.status,
				manifestJson: manifest,
			})
			.returning();
		if (!row) throw new Error("Failed to save workflow browser artifact");
		return toWorkflowBrowserArtifactRecord(row);
	}

	async listByExecutionId(
		workflowExecutionId: string,
	): Promise<WorkflowBrowserArtifactRecord[]> {
		const rows = await this.database
			.select()
			.from(workflowBrowserArtifacts)
			.where(eq(workflowBrowserArtifacts.workflowExecutionId, workflowExecutionId))
			.orderBy(desc(workflowBrowserArtifacts.createdAt));
		return rows.map((row) => toWorkflowBrowserArtifactRecord(row));
	}

	async getBlobPayload(
		storageRef: string,
	): Promise<{ payloadBase64: string; contentType: string } | null> {
		const [row] = await this.database
			.select()
			.from(workflowBrowserArtifactBlobPayloads)
			.where(eq(workflowBrowserArtifactBlobPayloads.storageRef, storageRef))
			.limit(1);
		return row
			? { payloadBase64: row.payloadText, contentType: row.contentType }
			: null;
	}
}

export class PostgresApiKeyStore implements ApiKeyStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getByKeyHash(keyHash: string): Promise<ApiKeyRecord | null> {
		const [row] = await this.database
			.select({ id: apiKeys.id, userId: apiKeys.userId })
			.from(apiKeys)
			.where(eq(apiKeys.keyHash, keyHash))
			.limit(1);
		return row ?? null;
	}

	async markUsed(apiKeyId: string, usedAt: Date): Promise<void> {
		await this.database
			.update(apiKeys)
			.set({ lastUsedAt: usedAt })
			.where(eq(apiKeys.id, apiKeyId));
	}

	listByUserId(userId: string) {
		return this.database
			.select({
				id: apiKeys.id,
				name: apiKeys.name,
				keyPrefix: apiKeys.keyPrefix,
				createdAt: apiKeys.createdAt,
				lastUsedAt: apiKeys.lastUsedAt,
			})
			.from(apiKeys)
			.where(eq(apiKeys.userId, userId))
			.orderBy(desc(apiKeys.createdAt));
	}

	async createUserApiKey(input: {
		id: string;
		userId: string;
		name: string;
		keyHash: string;
		keyPrefix: string;
	}) {
		const [created] = await this.database
			.insert(apiKeys)
			.values({
				id: input.id,
				userId: input.userId,
				name: input.name,
				keyHash: input.keyHash,
				keyPrefix: input.keyPrefix,
			})
			.returning({
				id: apiKeys.id,
				name: apiKeys.name,
				keyPrefix: apiKeys.keyPrefix,
				createdAt: apiKeys.createdAt,
				lastUsedAt: apiKeys.lastUsedAt,
			});
		if (!created) throw new Error("Failed to create API key");
		return created;
	}

	async deleteForUser(input: { id: string; userId: string }): Promise<boolean> {
		const deleted = await this.database
			.delete(apiKeys)
			.where(and(eq(apiKeys.id, input.id), eq(apiKeys.userId, input.userId)))
			.returning({ id: apiKeys.id });
		return deleted.length > 0;
	}

	async updateSecretForUser(input: {
		id: string;
		userId: string;
		keyHash: string;
		keyPrefix: string;
	}) {
		const [rotated] = await this.database
			.update(apiKeys)
			.set({
				keyHash: input.keyHash,
				keyPrefix: input.keyPrefix,
				lastUsedAt: null,
			})
			.where(and(eq(apiKeys.id, input.id), eq(apiKeys.userId, input.userId)))
			.returning({
				id: apiKeys.id,
				name: apiKeys.name,
				keyPrefix: apiKeys.keyPrefix,
				createdAt: apiKeys.createdAt,
				lastUsedAt: apiKeys.lastUsedAt,
			});
		return rotated ?? null;
	}
}

function workflowActivityRateSessionHostAppId(sessionId: string): string {
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
	return `agent-session-${digest}`;
}

export class PostgresWorkflowActivityRateTargetRepository
	implements WorkflowActivityRateTargetRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async resolveWorkflowActivityRateTarget(input: {
		executionId: string;
	}): Promise<WorkflowActivityRateTargetReadModel | null> {
		const executionId = input.executionId.trim();
		if (!executionId) return null;

		const [execution] = await this.database
			.select({ workflowSessionId: workflowExecutions.workflowSessionId })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		if (!execution) return null;

		const sessionFilter = execution.workflowSessionId
			? or(
					eq(sessions.id, execution.workflowSessionId),
					eq(sessions.workflowExecutionId, executionId),
				)
			: eq(sessions.workflowExecutionId, executionId);
		const [sessionRow] = await this.database
			.select({ id: sessions.id })
			.from(sessions)
			.where(sessionFilter)
			.orderBy(desc(sessions.createdAt))
			.limit(1);
		if (!sessionRow?.id) return null;

		return {
			executionId,
			sessionId: sessionRow.id,
			daprAppId: workflowActivityRateSessionHostAppId(sessionRow.id),
		};
	}
}

function observabilityTraceGoalVerdict(
	status: string,
): ObservabilityTraceGoalVerdict {
	if (status === "complete") return "pass";
	if (status === "budget_limited") return "limited";
	if (status === "paused") return "paused";
	return "active";
}

export class PostgresObservabilityTraceRepository implements ObservabilityTraceRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getTraceScope(input: {
		userId: string;
		projectId?: string | null;
		sessionIdFilter?: string | null;
		sessionLimit?: number;
		executionLimit?: number;
	}): Promise<ObservabilityTraceScopeReadModel | null> {
		const userId = input.userId.trim();
		if (!userId) return { sessionIds: [], executionIds: [], sessionIdFilter: null };
		const projectId = input.projectId ?? null;
		const sessionIdFilter = input.sessionIdFilter?.trim() || null;
		const sessionLimit = Math.max(1, Math.min(Math.trunc(input.sessionLimit ?? 1000), 1000));
		const executionLimit = Math.max(1, Math.min(Math.trunc(input.executionLimit ?? 1000), 1000));
		const sessionScopeWhere = projectId
			? or(
					eq(sessions.projectId, projectId),
					and(isNull(sessions.projectId), eq(sessions.userId, userId)),
				)
			: eq(sessions.userId, userId);
		const executionScopeWhere = projectId
			? or(
					eq(workflowExecutions.projectId, projectId),
					and(
						isNull(workflowExecutions.projectId),
						eq(workflowExecutions.userId, userId),
					),
				)
			: eq(workflowExecutions.userId, userId);

		const [sessionRows, executionRows] = await Promise.all([
			this.database
				.select({ id: sessions.id })
				.from(sessions)
				.where(sessionScopeWhere)
				.orderBy(desc(sessions.createdAt))
				.limit(sessionLimit),
			this.database
				.select({ id: workflowExecutions.id })
				.from(workflowExecutions)
				.where(executionScopeWhere)
				.orderBy(desc(workflowExecutions.startedAt))
				.limit(executionLimit),
		]);
		const sessionIds = sessionRows.map((row) => row.id);
		if (sessionIdFilter && !new Set(sessionIds).has(sessionIdFilter)) {
			return null;
		}

		return {
			sessionIds,
			executionIds: executionRows.map((row) => row.id),
			sessionIdFilter,
		};
	}

	async listTraceGoalChips(input: {
		sessionIds: string[];
	}): Promise<ObservabilityTraceGoalChipReadModel[]> {
		const ids = [...new Set(input.sessionIds.map((id) => id.trim()).filter(Boolean))];
		if (ids.length === 0) return [];
		const rows = await this.database
			.select({
				sessionId: threadGoals.sessionId,
				status: threadGoals.status,
				iterations: threadGoals.iterations,
			})
			.from(threadGoals)
			.where(inArray(threadGoals.sessionId, ids));
		return rows.map((row) => ({
			sessionId: row.sessionId,
			status: row.status,
			iterations: row.iterations,
			verdict: observabilityTraceGoalVerdict(row.status),
		}));
	}
}

export class PostgresWorkflowMonitorReadRepository implements WorkflowMonitorReadRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listFallbackExecutions(input: {
		limit: number;
	}): Promise<WorkflowMonitorFallbackExecutionReadModel[]> {
		const limit = Math.max(1, Math.min(Math.trunc(input.limit || 50), 200));
		return this.database
			.select({
				id: workflowExecutions.id,
				instanceId: workflowExecutions.daprInstanceId,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				status: workflowExecutions.status,
				phase: workflowExecutions.phase,
				progress: workflowExecutions.progress,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
			})
			.from(workflowExecutions)
			.leftJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit);
	}
}

const DEFAULT_AGENT_SKILL_USED_BY_LIMIT = 50;

function promptPresetRefs(
	config: unknown,
	key: "staticPromptPresetRefs" | "dynamicPromptPresetRefs",
): Array<{ id: string; version: number }> {
	if (!isRecord(config)) return [];
	const value = config[key];
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => {
			if (!isRecord(item) || typeof item.id !== "string") return null;
			const version = typeof item.version === "number" ? item.version : 0;
			return { id: item.id, version };
		})
		.filter((item): item is { id: string; version: number } => item !== null);
}

export class PostgresResourceUsageReadRepository implements ResourceUsageReadRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getPromptPresetUsages(input: {
		presetId: string;
		projectId: string;
	}) {
		const presetId = input.presetId.trim();
		const projectId = input.projectId.trim();
		if (!presetId || !projectId) return null;

		const [preset] = await this.database
			.select({
				id: resourcePrompts.id,
				version: resourcePrompts.version,
			})
			.from(resourcePrompts)
			.where(
				and(
					eq(resourcePrompts.id, presetId),
					eq(resourcePrompts.projectId, projectId),
				),
			)
			.limit(1);
		if (!preset) return null;

		const [latest] = await this.database
			.select({ version: resourcePromptVersions.version })
			.from(resourcePromptVersions)
			.where(eq(resourcePromptVersions.promptId, presetId))
			.orderBy(desc(resourcePromptVersions.version))
			.limit(1);
		const latestVersion = latest?.version ?? preset.version;

		const rows = await this.database
			.select({
				id: agents.id,
				slug: agents.slug,
				name: agents.name,
				config: agentVersions.config,
			})
			.from(agents)
			.leftJoin(agentVersions, eq(agentVersions.id, agents.currentVersionId))
			.where(and(eq(agents.projectId, projectId), eq(agents.isArchived, false)));

		const usages = [];
		for (const row of rows) {
			for (const ref of promptPresetRefs(row.config, "staticPromptPresetRefs")) {
				if (ref.id !== presetId) continue;
				usages.push({
					id: row.id,
					slug: row.slug,
					name: row.name,
					bindingKind: "static" as const,
					version: ref.version,
					latestVersion,
					isStale: ref.version < latestVersion,
				});
			}
			for (const ref of promptPresetRefs(row.config, "dynamicPromptPresetRefs")) {
				if (ref.id !== presetId) continue;
				usages.push({
					id: row.id,
					slug: row.slug,
					name: row.name,
					bindingKind: "dynamic" as const,
					version: ref.version,
					latestVersion,
					isStale: ref.version < latestVersion,
				});
			}
		}

		usages.sort((a, b) => {
			if (a.isStale !== b.isStale) return a.isStale ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return { usages, latestVersion };
	}

	async listAgentSkillUsedBy(input: {
		skillRef: string;
		projectId?: string | null;
		limit: number;
	}) {
		const skillRef = input.skillRef.trim();
		if (!skillRef) return null;
		const projectId = input.projectId ?? null;
		const limit = Math.max(
			1,
			Math.min(
				Math.trunc(input.limit || DEFAULT_AGENT_SKILL_USED_BY_LIMIT),
				DEFAULT_AGENT_SKILL_USED_BY_LIMIT,
			),
		);
		const skillScope = projectId
			? or(isNull(agentSkillRegistry.projectId), eq(agentSkillRegistry.projectId, projectId))
			: isNull(agentSkillRegistry.projectId);

		const [skill] = await this.database
			.select({
				id: agentSkillRegistry.id,
				slug: agentSkillRegistry.slug,
			})
			.from(agentSkillRegistry)
			.where(
				and(
					skillScope,
					or(eq(agentSkillRegistry.id, skillRef), eq(agentSkillRegistry.slug, skillRef)),
				),
			)
			.limit(1);
		if (!skill) return null;

		type AgentRow = {
			id: string;
			slug: string;
			name: string;
			projectId: string | null;
			runtimeAppId: string | null;
			registryStatus: string | null;
		};
		const all = await this.database.execute<AgentRow>(sql`
			SELECT a.id, a.slug, a.name, a.project_id AS "projectId",
			       a.runtime_app_id AS "runtimeAppId", a.registry_status AS "registryStatus"
			FROM agents a
			JOIN agent_versions av ON av.id = a.current_version_id
			WHERE a.is_archived = false
				AND NOT COALESCE(a.tags, '[]'::jsonb) @> '["workflow-ephemeral"]'::jsonb
				AND (${projectId === null}::boolean OR a.project_id = ${projectId} OR a.project_id IS NULL)
				AND EXISTS (
					SELECT 1
					FROM jsonb_array_elements(COALESCE(av.config->'skills', '[]'::jsonb)) se
					WHERE (se->>'registryId') = ${skill.id}
					   OR (se->>'slug') = ${skill.slug}
				)
			ORDER BY a.name ASC
			LIMIT ${limit + 1}
		`);
		const truncated = all.length > limit;
		return {
			agents: truncated ? all.slice(0, limit) : all,
			truncated,
			total: all.length,
		};
	}

	async getVaultUsages(input: { vaultId: string }) {
		const vaultId = input.vaultId.trim();
		if (!vaultId) return { agents: [], sessionCount: 0 };

		const [referencingAgents, sessionCountRows] = await Promise.all([
			this.database
				.select({
					id: agents.id,
					slug: agents.slug,
					name: agents.name,
					avatar: agents.avatar,
					isArchived: agents.isArchived,
				})
				.from(agents)
				.where(
					and(
						sql`${agents.defaultVaultIds} @> ${JSON.stringify([vaultId])}::jsonb`,
						eq(agents.isArchived, false),
					),
				),
			this.database
				.select({ count: sql<number>`count(*)` })
				.from(sessions)
				.where(sql`${sessions.vaultIds} @> ${JSON.stringify([vaultId])}::jsonb`),
		]);

		return {
			agents: referencingAgents.map((agent) => ({
				id: agent.id,
				slug: agent.slug,
				name: agent.name,
				avatar: agent.avatar ?? null,
				isArchived: agent.isArchived,
			})),
			sessionCount: Number(sessionCountRows[0]?.count ?? 0),
		};
	}
}

export class PostgresWorkflowAiAssistantMessageRepository
	implements WorkflowAiAssistantMessageRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listMessages(input: {
		workflowId: string;
		userId: string;
		limit: number;
	}) {
		const workflowId = input.workflowId.trim();
		const userId = input.userId.trim();
		if (!workflowId || !userId) return [];
		const limit = Math.max(1, Math.min(Math.trunc(input.limit || 100), 500));

		const rows = await this.database
			.select({
				id: workflowAiMessages.id,
				role: workflowAiMessages.role,
				content: workflowAiMessages.content,
				operations: workflowAiMessages.operations,
				createdAt: workflowAiMessages.createdAt,
			})
			.from(workflowAiMessages)
			.where(
				and(
					eq(workflowAiMessages.workflowId, workflowId),
					eq(workflowAiMessages.userId, userId),
				),
			)
			.orderBy(asc(workflowAiMessages.createdAt))
			.limit(limit);

		return rows.map((row) => ({
			id: row.id,
			role: row.role,
			content: row.content,
			operations: row.operations ?? null,
			createdAt: row.createdAt,
		}));
	}

	async deleteMessages(input: {
		workflowId: string;
		userId: string;
	}): Promise<void> {
		const workflowId = input.workflowId.trim();
		const userId = input.userId.trim();
		if (!workflowId || !userId) return;

		await this.database
			.delete(workflowAiMessages)
			.where(
				and(
					eq(workflowAiMessages.workflowId, workflowId),
					eq(workflowAiMessages.userId, userId),
				),
			);
	}
}

export class PostgresSecurityAuditReadRepository implements SecurityAuditReadRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getSecurityAudit(input: {
		projectId?: string | null;
		since: Date;
		now: Date;
		limit: number;
	}) {
		const projectId = input.projectId ?? null;
		const limit = Math.max(1, Math.min(Math.trunc(input.limit || 100), 500));

		const [creds, members, configs] = await Promise.all([
			this.database
				.select({
					id: credentialAccessLogs.id,
					at: credentialAccessLogs.accessedAt,
					integration: credentialAccessLogs.integrationType,
					source: credentialAccessLogs.source,
					executionId: credentialAccessLogs.executionId,
					fallbackAttempted: credentialAccessLogs.fallbackAttempted,
				})
				.from(credentialAccessLogs)
				.where(gte(credentialAccessLogs.accessedAt, input.since))
				.orderBy(desc(credentialAccessLogs.accessedAt))
				.limit(limit),
			projectId
				? this.database
						.select({
							id: projectMembers.id,
							at: projectMembers.createdAt,
							role: projectMembers.role,
							userId: users.id,
							email: users.email,
							name: users.name,
						})
						.from(projectMembers)
						.innerJoin(users, eq(users.id, projectMembers.userId))
						.where(
							and(
								eq(projectMembers.projectId, projectId),
								gte(projectMembers.createdAt, input.since),
							),
						)
						.orderBy(desc(projectMembers.createdAt))
						.limit(50)
				: Promise.resolve([]),
			projectId
				? this.database
						.select({
							id: runtimeConfigAuditLogs.id,
							at: runtimeConfigAuditLogs.createdAt,
							key: runtimeConfigAuditLogs.configKey,
							status: runtimeConfigAuditLogs.status,
							actor: runtimeConfigAuditLogs.userId,
						})
						.from(runtimeConfigAuditLogs)
						.where(
							and(
								eq(runtimeConfigAuditLogs.projectId, projectId),
								gte(runtimeConfigAuditLogs.createdAt, input.since),
							),
						)
						.orderBy(desc(runtimeConfigAuditLogs.createdAt))
						.limit(50)
				: Promise.resolve([]),
		]);

		const events = [
			...creds.map((row) => ({
				id: `cred:${row.id}`,
				at: row.at.toISOString(),
				kind: "credential.access" as const,
				summary: `${row.integration} credential resolved via ${row.source}${row.fallbackAttempted ? " (fallback)" : ""}`,
				executionId: row.executionId,
			})),
			...members.map((row) => ({
				id: `member:${row.id}`,
				at: row.at.toISOString(),
				kind: "member.added" as const,
				summary: `${row.name ?? row.email ?? row.userId} joined as ${row.role}`,
			})),
			...configs.map((row) => ({
				id: `config:${row.id}`,
				at: row.at.toISOString(),
				kind: "config.change" as const,
				summary: `${row.key} updated (${row.status})`,
				actor: row.actor,
			})),
		]
			.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
			.slice(0, limit);

		return {
			events,
			asOf: input.now.toISOString(),
		};
	}
}

export class PostgresDashboardReadRepository implements DashboardReadRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getDashboard(input: { userId: string; now: Date }) {
		const userId = input.userId.trim();
		const dayAgo = new Date(input.now.getTime() - 24 * 60 * 60 * 1000);
		const weekAgo = new Date(input.now.getTime() - 7 * 24 * 60 * 60 * 1000);

		const [activeCount, todayCount, archivedCount, tokens, activeSessions] =
			await Promise.all([
				this.database
					.select({ n: sql<number>`count(*)` })
					.from(sessions)
					.where(and(eq(sessions.userId, userId), eq(sessions.status, "running")))
					.then((rows) => rows[0]),
				this.database
					.select({ n: sql<number>`count(*)` })
					.from(sessions)
					.where(and(eq(sessions.userId, userId), gte(sessions.createdAt, dayAgo)))
					.then((rows) => rows[0]),
				this.database
					.select({ n: sql<number>`count(*)` })
					.from(sessions)
					.where(
						and(
							eq(sessions.userId, userId),
							isNotNull(sessions.archivedAt),
							gte(sessions.archivedAt, dayAgo),
						),
					)
					.then((rows) => rows[0]),
				this.database
					.select({
						outTokens: sql<number>`coalesce(sum((usage->>'output_tokens')::int), 0)`,
						inTokens: sql<number>`coalesce(sum((usage->>'input_tokens')::int), 0)`,
					})
					.from(sessions)
					.where(and(eq(sessions.userId, userId), gte(sessions.createdAt, weekAgo)))
					.then((rows) => rows[0]),
				this.database
					.select({
						id: sessions.id,
						title: sessions.title,
						status: sessions.status,
						agentId: sessions.agentId,
						updatedAt: sessions.updatedAt,
						createdAt: sessions.createdAt,
					})
					.from(sessions)
					.where(
						and(
							eq(sessions.userId, userId),
							inArray(sessions.status, ["running", "idle"]),
							isNull(sessions.archivedAt),
						),
					)
					.orderBy(desc(sessions.updatedAt))
					.limit(5),
			]);

		const agentIds = Array.from(
			new Set(activeSessions.map((session) => session.agentId).filter(Boolean)),
		);
		const agentRows = agentIds.length
			? await this.database
					.select({ id: agents.id, name: agents.name, avatar: agents.avatar })
					.from(agents)
					.where(inArray(agents.id, agentIds))
			: [];
		const agentMap = new Map(agentRows.map((agent) => [agent.id, agent]));

		const [recentAgentVersions, recentEnvVersions] = await Promise.all([
			this.database
				.select({
					id: agentVersions.id,
					version: agentVersions.version,
					publishedAt: agentVersions.publishedAt,
					agentId: agentVersions.agentId,
				})
				.from(agentVersions)
				.where(isNotNull(agentVersions.publishedAt))
				.orderBy(desc(agentVersions.publishedAt))
				.limit(10),
			this.database
				.select({
					id: environmentVersions.id,
					version: environmentVersions.version,
					publishedAt: environmentVersions.publishedAt,
					environmentId: environmentVersions.environmentId,
				})
				.from(environmentVersions)
				.where(isNotNull(environmentVersions.publishedAt))
				.orderBy(desc(environmentVersions.publishedAt))
				.limit(10),
		]);

		const agentLookup = new Map(agentRows.map((agent) => [agent.id, agent.name]));
		const missingAgentIds = Array.from(
			new Set(
				recentAgentVersions
					.map((version) => version.agentId)
					.filter((id) => !agentLookup.has(id)),
			),
		);
		if (missingAgentIds.length > 0) {
			const rows = await this.database
				.select({ id: agents.id, name: agents.name })
				.from(agents)
				.where(inArray(agents.id, missingAgentIds));
			for (const row of rows) agentLookup.set(row.id, row.name);
		}

		const envLookup = new Map<string, string>();
		const envIds = Array.from(
			new Set(recentEnvVersions.map((version) => version.environmentId)),
		);
		if (envIds.length > 0) {
			const rows = await this.database
				.select({ id: environments.id, name: environments.name })
				.from(environments)
				.where(inArray(environments.id, envIds));
			for (const row of rows) envLookup.set(row.id, row.name);
		}

		const recentChanges = [
			...recentAgentVersions.map((version) => ({
				kind: "agent" as const,
				resourceId: version.agentId,
				resourceName: agentLookup.get(version.agentId) ?? version.agentId,
				version: version.version,
				publishedAt: version.publishedAt?.toISOString() ?? null,
			})),
			...recentEnvVersions.map((version) => ({
				kind: "environment" as const,
				resourceId: version.environmentId,
				resourceName: envLookup.get(version.environmentId) ?? version.environmentId,
				version: version.version,
				publishedAt: version.publishedAt?.toISOString() ?? null,
			})),
		]
			.sort(
				(a, b) =>
					new Date(b.publishedAt ?? 0).getTime() -
					new Date(a.publishedAt ?? 0).getTime(),
			)
			.slice(0, 10);

		const [[{ n: totalAgents }], [{ n: totalEnvs }], [{ n: totalVaults }]] =
			await Promise.all([
				this.database
					.select({ n: sql<number>`count(*)` })
					.from(agents)
					.where(eq(agents.isArchived, false)),
				this.database
					.select({ n: sql<number>`count(*)` })
					.from(environments)
					.where(eq(environments.isArchived, false)),
				this.database
					.select({ n: sql<number>`count(*)` })
					.from(vaults)
					.where(eq(vaults.isArchived, false)),
			]);

		return {
			stats: {
				activeSessions: Number(activeCount?.n ?? 0),
				sessionsToday: Number(todayCount?.n ?? 0),
				archivedLast24h: Number(archivedCount?.n ?? 0),
				tokensOut7d: Number(tokens?.outTokens ?? 0),
				tokensIn7d: Number(tokens?.inTokens ?? 0),
				totalAgents: Number(totalAgents ?? 0),
				totalEnvironments: Number(totalEnvs ?? 0),
				totalVaults: Number(totalVaults ?? 0),
			},
			activeSessions: activeSessions.map((session) => ({
				id: session.id,
				title: session.title ?? null,
				status: session.status,
				agentId: session.agentId,
				agentName: agentMap.get(session.agentId)?.name ?? session.agentId,
				agentAvatar: agentMap.get(session.agentId)?.avatar ?? null,
				updatedAt: session.updatedAt.toISOString(),
				createdAt: session.createdAt.toISOString(),
			})),
			recentChanges,
		};
	}
}

export class PostgresHomePageReadRepository implements HomePageReadRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async listRecentHomeSessions(input: {
		userId: string;
		projectId?: string | null;
		limit: number;
	}) {
		const conditions = [
			eq(sessions.userId, input.userId),
			isNull(sessions.archivedAt),
		];
		if (input.projectId) conditions.push(eq(sessions.projectId, input.projectId));
		const limit = Math.min(Math.max(input.limit, 1), 20);
		return this.database
			.select({
				id: sessions.id,
				title: sessions.title,
				status: sessions.status,
				agentId: sessions.agentId,
				updatedAt: sessions.updatedAt,
			})
			.from(sessions)
			.where(and(...conditions))
			.orderBy(desc(sessions.createdAt))
			.limit(limit);
	}

	async listRecentHomeRuns(input: { projectId: string; limit: number }) {
		const limit = Math.min(Math.max(input.limit, 1), 20);
		return this.database
			.select({
				executionId: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				duration: workflowExecutions.duration,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(workflowExecutions.projectId, input.projectId))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit);
	}
}

export class PostgresWorkflowExecutionRepository implements WorkflowExecutionRepository {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async assertReadModelReady(): Promise<void> {
		const rows = await this.database.execute<{ column_name: string }>(sql`
			select column_name
			from information_schema.columns
			where table_schema = 'public'
				and table_name = 'workflow_executions'
		`);
		const existing = new Set(rows.map((row) => row.column_name));
		const missing = EXECUTION_READ_MODEL_COLUMNS.filter((column) => !existing.has(column));
		if (missing.length > 0) {
			throw new Error(
				`Execution read-model schema is missing required workflow_executions columns: ${missing.join(", ")}. ` +
					`Apply ${EXECUTION_READ_MODEL_MIGRATIONS.join(" or ")} before starting workflow-builder.`,
			);
		}
	}

	async getById(id: string): Promise<WorkflowExecutionRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, id))
			.limit(1);
		return row ? mapExecution(row) : null;
	}

	async getByDaprInstanceId(instanceId: string): Promise<WorkflowExecutionRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowExecutions)
			.where(eq(workflowExecutions.daprInstanceId, instanceId))
			.limit(1);
		return row ? mapExecution(row) : null;
	}

	async getSessionOwnerContext(
		executionId: string,
	): Promise<WorkflowExecutionSessionOwnerContext | null> {
		const [row] = await this.database
			.select({
				userId: workflowExecutions.userId,
				workflowId: workflowExecutions.workflowId,
				projectId: workflows.projectId,
			})
			.from(workflowExecutions)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		return row ?? null;
	}

	async getExecutionWorkspaceRoute(
		executionId: string,
	): Promise<ExecutionWorkspaceRouteInfo | null> {
		const [execution] = await this.database
			.select({
				userId: workflowExecutions.userId,
				executionProjectId: workflowExecutions.projectId,
				workflowProjectId: workflows.projectId,
			})
			.from(workflowExecutions)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);

		const projectId = execution?.executionProjectId || execution?.workflowProjectId;
		if (!execution || !projectId) return null;

		const [project] = await this.database
			.select({ externalId: projects.externalId })
			.from(projects)
			.where(eq(projects.id, projectId))
			.limit(1);

		return {
			projectId,
			userId: execution.userId,
			workspaceSlug: project?.externalId || projectId,
		};
	}

	async getRunningByWorkflowId(workflowId: string): Promise<{ id: string; status: string } | null> {
		const [row] = await this.database
			.select({ id: workflowExecutions.id, status: workflowExecutions.status })
			.from(workflowExecutions)
			.where(
				and(
					eq(workflowExecutions.workflowId, workflowId),
					eq(workflowExecutions.status, "running"),
				),
			)
			.limit(1);
		return row ?? null;
	}

	async countActiveTriggeredRuns(input: { statuses: WorkflowExecutionStatus[] }): Promise<number> {
		if (input.statuses.length === 0) return 0;
		const [row] = await this.database
			.select({ n: sql<number>`count(*)::int` })
			.from(workflowExecutions)
			.where(
				and(
					isNotNull(workflowExecutions.triggerSource),
					inArray(workflowExecutions.status, input.statuses),
				),
			);
		return row?.n ?? 0;
	}

	async getLineage(executionId: string): Promise<WorkflowExecutionLineage | null> {
		const [self] = await this.database
			.select({
				id: workflowExecutions.id,
				rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		if (!self) return null;

		let rootId = self.id;
		let cursor: string | null = self.rerunOfExecutionId ?? null;
		for (let hops = 0; hops < 50 && cursor; hops++) {
			const [parent]: Array<{ id: string; parent: string | null }> = await this.database
				.select({ id: workflowExecutions.id, parent: workflowExecutions.rerunOfExecutionId })
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, cursor))
				.limit(1);
			if (!parent) break;
			rootId = parent.id;
			cursor = parent.parent ?? null;
		}

		const collected = new Map<
			string,
			{
				id: string;
				status: string | null;
				resumeFromNode: string | null;
				rerunOfExecutionId: string | null;
				startedAt: Date | null;
				completedAt: Date | null;
				duration: string | null;
			}
		>();
		let frontier: string[] = [rootId];
		for (let depth = 0; depth < 50 && frontier.length > 0; depth++) {
			const rows = await this.database
				.select({
					id: workflowExecutions.id,
					status: workflowExecutions.status,
					resumeFromNode: workflowExecutions.resumeFromNode,
					rerunOfExecutionId: workflowExecutions.rerunOfExecutionId,
					startedAt: workflowExecutions.startedAt,
					completedAt: workflowExecutions.completedAt,
					duration: workflowExecutions.duration,
				})
				.from(workflowExecutions)
				.where(inArray(workflowExecutions.id, frontier));
			const next: string[] = [];
			for (const row of rows) {
				if (collected.has(row.id)) continue;
				collected.set(row.id, row);
				next.push(row.id);
			}
			if (next.length === 0) break;

			const children = await this.database
				.select({ id: workflowExecutions.id })
				.from(workflowExecutions)
				.where(inArray(workflowExecutions.rerunOfExecutionId, next));
			frontier = children.map((child) => child.id).filter((id) => !collected.has(id));
		}

		return {
			rootId,
			currentId: executionId,
			nodes: [...collected.values()].map((row) => {
				const durationMs =
					row.duration != null && row.duration !== ""
						? Number(row.duration)
						: row.completedAt && row.startedAt
							? row.completedAt.getTime() - row.startedAt.getTime()
							: null;
				return {
					id: row.id,
					status: row.status,
					fromNodeId: row.resumeFromNode ?? null,
					parentId: row.rerunOfExecutionId ?? null,
					startedAt: row.startedAt?.toISOString() ?? null,
					completedAt: row.completedAt?.toISOString() ?? null,
					durationMs: Number.isFinite(durationMs as number) ? (durationMs as number) : null,
					isCurrent: row.id === executionId,
				};
			}),
		};
	}

	async listActiveForUser(userId: string): Promise<ActiveWorkflowExecutionReadModel[]> {
		const rows = await this.database
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				status: workflowExecutions.status,
				phase: workflowExecutions.phase,
			})
			.from(workflowExecutions)
			.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
			.where(
				and(
					eq(workflowExecutions.userId, userId),
					inArray(workflowExecutions.status, ["pending", "running"]),
				),
			)
			.limit(50);

		return rows.map((row) => ({
			...row,
			approvalEventName: null,
		}));
	}

	async listForInternalAgent(
		input: InternalAgentWorkflowExecutionListInput,
	): Promise<InternalAgentWorkflowExecutionListReadModel> {
		const filters = [];
		const workflowId = input.workflowId?.trim();
		const workflowName = input.workflowName?.trim();
		if (workflowId) {
			filters.push(eq(workflowExecutions.workflowId, workflowId));
		}
		if (workflowName) {
			filters.push(eq(workflows.name, workflowName));
		}
		if (input.status) {
			filters.push(eq(workflowExecutions.status, input.status));
		}
		const whereClause = filters.length > 0 ? and(...filters) : undefined;
		const limit = Math.max(1, Math.min(Number.isFinite(input.limit) ? input.limit : 100, 500));
		const offset = Math.max(0, Number.isFinite(input.offset) ? input.offset : 0);

		const [executions, totalRows] = await Promise.all([
			this.database
				.select({
					id: workflowExecutions.id,
					workflowId: workflowExecutions.workflowId,
					status: workflowExecutions.status,
					phase: workflowExecutions.phase,
					progress: workflowExecutions.progress,
					error: workflowExecutions.error,
					startedAt: workflowExecutions.startedAt,
					completedAt: workflowExecutions.completedAt,
					workflow: {
						id: workflows.id,
						name: workflows.name,
						description: workflows.description,
					},
				})
				.from(workflowExecutions)
				.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
				.where(whereClause)
				.orderBy(desc(workflowExecutions.startedAt))
				.limit(limit)
				.offset(offset),
			this.database
				.select({ value: count() })
				.from(workflowExecutions)
				.innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
				.where(whereClause),
		]);

		return {
			success: true,
			executions,
			total: totalRows[0]?.value ?? 0,
		};
	}

	async listByWorkflowId(input: {
		workflowId: string;
		limit: number;
		include?: "summary" | "full";
	}): Promise<WorkflowExecutionListItem[]> {
		const limit = Number.isFinite(input.limit) ? Math.max(1, input.limit) : 20;
		const includeFull = input.include === "full";
		const summaryColumns = {
			id: workflowExecutions.id,
			workflowId: workflowExecutions.workflowId,
			status: workflowExecutions.status,
			daprInstanceId: workflowExecutions.daprInstanceId,
			startedAt: workflowExecutions.startedAt,
			completedAt: workflowExecutions.completedAt,
			duration: workflowExecutions.duration,
		};
		const rows = await this.database
			.select(
				includeFull
					? {
							...summaryColumns,
							input: workflowExecutions.input,
							output: workflowExecutions.output,
						}
					: summaryColumns,
			)
			.from(workflowExecutions)
			.where(eq(workflowExecutions.workflowId, input.workflowId))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit);

		return rows.map((row) => ({
			id: row.id,
			workflowId: row.workflowId,
			status: row.status,
			daprInstanceId: row.daprInstanceId,
			startedAt: row.startedAt,
			completedAt: row.completedAt,
			duration: row.duration,
			...(includeFull
				? {
						input: "input" in row ? row.input ?? null : null,
						output: "output" in row ? row.output : null,
					}
				: {}),
		}));
	}

	async listRunSummariesByWorkflowId(input: {
		workflowId: string;
		limit: number;
	}): Promise<WorkflowExecutionRunSummary[]> {
		const limit = Number.isFinite(input.limit) ? Math.max(1, input.limit) : 20;
		const execRows = await this.database
			.select({
				id: workflowExecutions.id,
				workflowId: workflowExecutions.workflowId,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
				duration: workflowExecutions.duration,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.workflowId, input.workflowId))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit);

		const execIds = execRows.map((row) => row.id).filter(Boolean);
		if (execIds.length === 0) return [];

		const sessionRows = await this.database
			.select({
				id: sessions.id,
				workflowExecutionId: sessions.workflowExecutionId,
				agentId: sessions.agentId,
			})
			.from(sessions)
			.where(inArray(sessions.workflowExecutionId, execIds));

		const agentIds = Array.from(
			new Set(sessionRows.map((session) => session.agentId).filter((id): id is string => !!id)),
		);
		const agentNameById = new Map<string, string>();
		if (agentIds.length > 0) {
			const agentRows = await this.database
				.select({ id: agents.id, name: agents.name })
				.from(agents)
				.where(inArray(agents.id, agentIds));
			for (const agent of agentRows) agentNameById.set(agent.id, agent.name);
		}

		const byExecution = new Map<
			string,
			{ sessionIds: string[]; agents: { id: string; name: string }[] }
		>();
		for (const session of sessionRows) {
			const execId = session.workflowExecutionId;
			if (!execId) continue;
			const bucket = byExecution.get(execId) ?? { sessionIds: [], agents: [] };
			bucket.sessionIds.push(session.id);
			if (session.agentId && !bucket.agents.find((agent) => agent.id === session.agentId)) {
				bucket.agents.push({
					id: session.agentId,
					name: agentNameById.get(session.agentId) ?? session.agentId,
				});
			}
			byExecution.set(execId, bucket);
		}

		return execRows.map((execution) => {
			const extras = byExecution.get(execution.id) ?? { sessionIds: [], agents: [] };
			return {
				id: execution.id,
				workflowId: execution.workflowId,
				status: execution.status,
				startedAt: execution.startedAt,
				completedAt: execution.completedAt,
				duration: execution.duration,
				sessionIds: extras.sessionIds,
				agents: extras.agents,
			};
		});
	}

	async countForksByWorkflowIds(
		workflowIds: string[],
	): Promise<WorkflowExecutionForkCountRecord[]> {
		if (workflowIds.length === 0) return [];
		const rows = await this.database
			.select({
				workflowId: workflowExecutions.workflowId,
				count: sql<number>`count(*)::int`,
			})
			.from(workflowExecutions)
			.where(
				and(
					inArray(workflowExecutions.workflowId, workflowIds),
					isNotNull(workflowExecutions.rerunOfExecutionId),
				),
			)
			.groupBy(workflowExecutions.workflowId);
		return rows.map((row) => ({
			workflowId: row.workflowId,
			count: Number(row.count) || 0,
		}));
	}

	async listRecentRunsByWorkflowIds(input: {
		workflowIds: string[];
		limitPerWorkflow: number;
	}): Promise<WorkflowExecutionRecentRunRecord[]> {
		if (input.workflowIds.length === 0) return [];
		const limitPerWorkflow = Number.isFinite(input.limitPerWorkflow)
			? Math.max(1, input.limitPerWorkflow)
			: 3;
		const runs: WorkflowExecutionRecentRunRecord[] = [];
		for (const workflowId of input.workflowIds) {
			const rows = await this.database
				.select({
					workflowId: workflowExecutions.workflowId,
					id: workflowExecutions.id,
					status: workflowExecutions.status,
					startedAt: workflowExecutions.startedAt,
					completedAt: workflowExecutions.completedAt,
				})
				.from(workflowExecutions)
				.where(eq(workflowExecutions.workflowId, workflowId))
				.orderBy(desc(workflowExecutions.startedAt))
				.limit(limitPerWorkflow);
			runs.push(...rows);
		}
		return runs;
	}

	async listRecentExecutionPickerRecords(input: {
		userId: string;
		projectId?: string | null;
		limit: number;
	}): Promise<WorkflowExecutionPickerRecord[]> {
		const limit = Number.isFinite(input.limit) ? Math.max(1, input.limit) : 50;
		return this.database
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				workflowId: workflowExecutions.workflowId,
			})
			.from(workflowExecutions)
			.where(
				input.projectId
					? or(
							eq(workflowExecutions.projectId, input.projectId),
							and(
								isNull(workflowExecutions.projectId),
								eq(workflowExecutions.userId, input.userId),
							),
						)
					: eq(workflowExecutions.userId, input.userId),
			)
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(limit);
	}

	async listSessionsForExecutionLineage(input: {
		executionId: string;
		projectId?: string | null;
		maxAncestors?: number;
	}): Promise<WorkflowExecutionSessionSummary[]> {
		const execIds: string[] = [input.executionId];
		let cursor: string | null = input.executionId;
		const maxAncestors = Math.max(0, input.maxAncestors ?? 20);
		for (let hops = 0; hops < maxAncestors && cursor; hops++) {
			const rows: Array<{ parent: string | null }> = await this.database
				.select({ parent: workflowExecutions.rerunOfExecutionId })
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, cursor))
				.limit(1);
			const parent: string | null = rows[0]?.parent ?? null;
			if (parent && !execIds.includes(parent)) {
				execIds.push(parent);
				cursor = parent;
			} else {
				cursor = null;
			}
		}

		const conditions = [inArray(sessions.workflowExecutionId, execIds)];
		if (input.projectId) {
			conditions.push(eq(sessions.projectId, input.projectId));
		}

		return this.database
			.select({
				id: sessions.id,
				title: sessions.title,
				status: sessions.status,
				agentId: sessions.agentId,
				workflowExecutionId: sessions.workflowExecutionId,
				createdAt: sessions.createdAt,
				completedAt: sessions.completedAt,
			})
			.from(sessions)
			.where(and(...conditions))
			.orderBy(asc(sessions.createdAt));
	}

	async listOutputFilesByExecutionId(
		executionId: string,
	): Promise<WorkflowExecutionOutputFiles> {
		const sessionRows = await this.database
			.select({
				id: sessions.id,
				status: sessions.status,
				sandboxName: sessions.sandboxName,
				workspaceSandboxName: sessions.workspaceSandboxName,
				runtimeAppId: sessions.runtimeAppId,
				updatedAt: sessions.updatedAt,
			})
			.from(sessions)
			.where(eq(sessions.workflowExecutionId, executionId))
			.orderBy(desc(sessions.updatedAt));

		const scopeIds = [executionId, ...sessionRows.map((session) => session.id)];
		const fileRows = await this.database
			.select({
				id: files.id,
				name: files.name,
				contentType: files.contentType,
				sizeBytes: files.sizeBytes,
				createdAt: files.createdAt,
			})
			.from(files)
			.where(
				and(
					inArray(files.scopeId, scopeIds),
					eq(files.purpose, "output"),
					isNull(files.archivedAt),
				),
			)
			.orderBy(desc(files.createdAt))
			.limit(500);

		const cliSlugs = new Set(["claude-code-cli", "codex-cli", "agy-cli"]);
		const cliWorkspace = sessionRows.some(
			(session) =>
				cliSlugs.has(String(session.sandboxName ?? "")) ||
				String(session.runtimeAppId ?? "").startsWith("agent-session-"),
		);

		const nonTerminalStatuses = new Set([
			"running",
			"active",
			"provisioning",
			"rescheduling",
			"starting",
			"paused",
			"idle",
		]);
		let liveSandbox: { name: string } | null = null;
		if (!cliWorkspace) {
			for (const session of sessionRows) {
				if (!nonTerminalStatuses.has(String(session.status ?? "").toLowerCase())) continue;
				if (session.workspaceSandboxName) {
					liveSandbox = { name: session.workspaceSandboxName };
					break;
				}
			}
		}

		return { files: fileRows, liveSandbox, cliWorkspace };
	}

	async aggregateUsageMetricsForExecutionLineage(input: {
		executionId: string;
		projectId?: string | null;
		maxAncestors?: number;
	}): Promise<WorkflowExecutionUsageMetricsRow[]> {
		const execIds: string[] = [input.executionId];
		let cursor: string | null = input.executionId;
		const maxAncestors = Math.max(0, input.maxAncestors ?? 20);
		for (let hops = 0; hops < maxAncestors && cursor; hops++) {
			const rows: Array<{ parent: string | null }> = await this.database
				.select({ parent: workflowExecutions.rerunOfExecutionId })
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, cursor))
				.limit(1);
			const parent: string | null = rows[0]?.parent ?? null;
			if (parent && !execIds.includes(parent)) {
				execIds.push(parent);
				cursor = parent;
			} else {
				cursor = null;
			}
		}

		type Row = {
			model_spec: string | null;
			input_tokens: number;
			output_tokens: number;
			cache_read: number;
			cache_create: number;
		};
		const rows = await this.database.execute<Row>(sql`
			SELECT
				coalesce(se.data->>'model', se.data->>'providerModel', 'unknown') AS model_spec,
				coalesce(sum((se.data->>'input_tokens')::bigint), 0) AS input_tokens,
				coalesce(sum((se.data->>'output_tokens')::bigint), 0) AS output_tokens,
				coalesce(sum((se.data->>'cache_read_input_tokens')::bigint), 0) AS cache_read,
				coalesce(sum((se.data->>'cache_creation_input_tokens')::bigint), 0) AS cache_create
			FROM session_events se
			JOIN sessions s ON s.id = se.session_id
			WHERE s.workflow_execution_id = ANY(${execIds})
				AND se.type = 'agent.llm_usage'
				${input.projectId ? sql`AND s.project_id = ${input.projectId}` : sql``}
			GROUP BY coalesce(se.data->>'model', se.data->>'providerModel', 'unknown')
		`);

		return rows.map((row) => ({
			modelSpec: row.model_spec,
			inputTokens: Number(row.input_tokens),
			outputTokens: Number(row.output_tokens),
			cacheReadTokens: Number(row.cache_read),
			cacheCreateTokens: Number(row.cache_create),
		}));
	}

	async create(input: CreateWorkflowExecutionInput): Promise<{ id: string }> {
		const [row] = await this.database
			.insert(workflowExecutions)
			.values({
				...(input.id ? { id: input.id } : {}),
				workflowId: input.workflowId,
				userId: input.userId,
				projectId: input.projectId ?? null,
				status: input.status,
				phase: input.phase ?? null,
				progress: input.progress ?? null,
				input: input.input,
				output: input.output,
				executionIr: input.executionIr,
				executionIrVersion: input.executionIrVersion ?? null,
				workflowSessionId: input.workflowSessionId ?? input.id ?? null,
				...(input.triggerSource ? { triggerSource: input.triggerSource } : {}),
				...(input.rerunOfExecutionId ? { rerunOfExecutionId: input.rerunOfExecutionId } : {}),
				...(input.rerunSourceInstanceId
					? { rerunSourceInstanceId: input.rerunSourceInstanceId }
					: {}),
				...(input.resumeFromNode ? { resumeFromNode: input.resumeFromNode } : {}),
			})
			.returning({ id: workflowExecutions.id });
		if (!row) throw new Error("Failed to create workflow execution");
		return row;
	}

	async attachSchedulerInstance(input: {
		executionId: string;
		instanceId: string;
		workflowSessionId?: string | null;
		primaryTraceId?: string | null;
	}): Promise<void> {
		await this.database
			.update(workflowExecutions)
			.set({
				daprInstanceId: input.instanceId,
				phase: "running",
				progress: 0,
				workflowSessionId: sql`coalesce(${workflowExecutions.workflowSessionId}, ${input.workflowSessionId ?? input.executionId})`,
				primaryTraceId: sql`coalesce(${workflowExecutions.primaryTraceId}, ${input.primaryTraceId ?? null})`,
			})
			.where(eq(workflowExecutions.id, input.executionId));
	}

	async markStartFailed(input: { executionId: string; error: string }): Promise<void> {
		await this.database
			.update(workflowExecutions)
			.set({
				status: "error",
				phase: "failed",
				progress: 100,
				error: input.error,
				completedAt: new Date(),
			})
			.where(eq(workflowExecutions.id, input.executionId));
	}

	async listStaleRunningExecutions(input: {
		olderThanMinutes: number;
	}): Promise<Pick<WorkflowExecutionRecord, "id" | "daprInstanceId" | "input">[]> {
		const cutoff = new Date(Date.now() - Math.max(0, input.olderThanMinutes) * 60_000);
		const rows = await this.database
			.select({
				id: workflowExecutions.id,
				daprInstanceId: workflowExecutions.daprInstanceId,
				input: workflowExecutions.input,
			})
			.from(workflowExecutions)
			.where(and(
				eq(workflowExecutions.status, "running"),
				lt(workflowExecutions.startedAt, cutoff),
			));
		return rows.map((row) => ({
			id: row.id,
			daprInstanceId: row.daprInstanceId,
			input: row.input ?? null,
		}));
	}

	async updateReadModel(
		executionId: string,
		patch: WorkflowExecutionReadModelPatch,
	): Promise<void> {
		await this.database
			.update(workflowExecutions)
			.set(patch)
			.where(eq(workflowExecutions.id, executionId));
	}

	async appendLog(input: AppendWorkflowExecutionLogInput): Promise<WorkflowExecutionLogRecord> {
		const [row] = await this.database
			.insert(workflowExecutionLogs)
			.values({
				...(input.id ? { id: input.id } : {}),
				executionId: input.executionId,
				nodeId: input.nodeId,
				nodeName: input.nodeName,
				nodeType: input.nodeType,
				activityName: input.activityName ?? null,
				status: input.status,
				input: input.input,
				output: input.output,
				error: input.error ?? null,
				...(input.startedAt ? { startedAt: input.startedAt } : {}),
				...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
				duration: input.duration ?? null,
				credentialFetchMs: input.credentialFetchMs ?? null,
				routingMs: input.routingMs ?? null,
				coldStartMs: input.coldStartMs ?? null,
				executionMs: input.executionMs ?? null,
				routedTo: input.routedTo ?? null,
				wasColdStart: input.wasColdStart ?? null,
			})
			.returning();
		if (!row) throw new Error("Failed to append workflow execution log");
		return mapExecutionLog(row);
	}

	async updateLog(
		executionId: string,
		id: string,
		patch: WorkflowExecutionLogPatch,
	): Promise<WorkflowExecutionLogRecord | null> {
		const [row] = await this.database
			.update(workflowExecutionLogs)
			.set(patch)
			.where(and(
				eq(workflowExecutionLogs.id, id),
				eq(workflowExecutionLogs.executionId, executionId),
			))
			.returning();
		return row ? mapExecutionLog(row) : null;
	}

	async listLogsByExecutionId(executionId: string): Promise<WorkflowExecutionLogRecord[]> {
		const rows = await this.database
			.select()
			.from(workflowExecutionLogs)
			.where(eq(workflowExecutionLogs.executionId, executionId))
			.orderBy(workflowExecutionLogs.startedAt);
		return rows.map(mapExecutionLog);
	}

	async listSessionIdsByExecutionId(executionId: string): Promise<string[]> {
		const rows = await this.database
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.workflowExecutionId, executionId));
		return rows.map((row) => row.id);
	}

	async listAgentEventsByExecutionId(executionId: string) {
		return this.database
			.select({
				id: sessionEvents.sequence,
				sessionId: sessionEvents.sessionId,
				type: sessionEvents.type,
				sourceEventId: sessionEvents.sourceEventId,
				data: sessionEvents.data,
				createdAt: sessionEvents.createdAt,
			})
			.from(sessionEvents)
			.innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
			.where(eq(sessions.workflowExecutionId, executionId))
			.orderBy(asc(sessionEvents.sequence));
	}

	async listAgentEventsByExecutionIdAfter(input: {
		executionId: string;
		afterEventId: number;
	}) {
		return this.database
			.select({
				id: sessionEvents.sequence,
				sessionId: sessionEvents.sessionId,
				type: sessionEvents.type,
				sourceEventId: sessionEvents.sourceEventId,
				data: sessionEvents.data,
				createdAt: sessionEvents.createdAt,
			})
			.from(sessionEvents)
			.innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
			.where(
				and(
					eq(sessions.workflowExecutionId, input.executionId),
					gt(sessionEvents.sequence, input.afterEventId),
				),
			)
			.orderBy(asc(sessionEvents.sequence));
	}
}

export class PostgresWorkflowFileStore implements WorkflowFileStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async createFile(input: CreateWorkflowFileInput): Promise<{
		file: WorkflowFileRecord;
		deduplicated: boolean;
	}> {
		if (input.bytes.byteLength > MAX_WORKFLOW_FILE_BYTES) {
			throw new Error(
				`file exceeds ${MAX_WORKFLOW_FILE_BYTES} byte limit (${input.bytes.byteLength})`,
			);
		}
		const sha1 = createHash("sha1").update(input.bytes).digest("hex");
		if (input.scopeId) {
			const [existing] = await this.database
				.select()
				.from(files)
				.where(
					and(
						eq(files.userId, input.userId),
						eq(files.scopeId, input.scopeId),
						eq(files.name, input.name),
						eq(files.sha1, sha1),
						isNull(files.archivedAt),
					),
				)
				.limit(1);
			if (existing) {
				return { file: mapWorkflowFile(existing), deduplicated: true };
			}
		}

		const storageRef = `file_${generateId()}`;
		await this.database.insert(filePayloads).values({
			storageRef,
			payloadBytes: input.bytes,
		});

		const [row] = await this.database
			.insert(files)
			.values({
				userId: input.userId,
				projectId: input.projectId ?? null,
				name: input.name,
				purpose: input.purpose,
				scopeId: input.scopeId ?? null,
				contentType: input.contentType ?? null,
				sizeBytes: input.bytes.byteLength,
				storageRef,
				sha1,
			})
			.returning();
		return { file: mapWorkflowFile(row), deduplicated: false };
	}

	async listFiles(filter: ListWorkflowFilesFilter): Promise<WorkflowFileRecord[]> {
		const conditions = [eq(files.userId, filter.userId)];
		if (filter.purpose) conditions.push(eq(files.purpose, filter.purpose));
		if (filter.scopeId) conditions.push(eq(files.scopeId, filter.scopeId));
		if (!filter.includeArchived) conditions.push(isNull(files.archivedAt));

		const rows = await this.database
			.select()
			.from(files)
			.where(and(...conditions))
			.orderBy(desc(files.createdAt))
			.limit(filter.limit ?? 200);
		return rows.map(mapWorkflowFile);
	}

	async getFile(id: string): Promise<WorkflowFileRecord | null> {
		const [row] = await this.database.select().from(files).where(eq(files.id, id)).limit(1);
		return row ? mapWorkflowFile(row) : null;
	}

	async getFileContent(
		id: string,
	): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null> {
		const [row] = await this.database.select().from(files).where(eq(files.id, id)).limit(1);
		if (!row) return null;
		const [payload] = await this.database
			.select({ bytes: filePayloads.payloadBytes })
			.from(filePayloads)
			.where(eq(filePayloads.storageRef, row.storageRef))
			.limit(1);
		if (!payload) return null;
		return { summary: mapWorkflowFile(row), bytes: payload.bytes };
	}

	async archiveFile(input: { id: string; userId: string }): Promise<boolean> {
		const [row] = await this.database
			.update(files)
			.set({ archivedAt: new Date() })
			.where(and(eq(files.id, input.id), eq(files.userId, input.userId)))
			.returning({ id: files.id });
		return Boolean(row);
	}

	async deleteFile(input: { id: string; userId: string }): Promise<boolean> {
		const [row] = await this.database
			.select({ storageRef: files.storageRef })
			.from(files)
			.where(and(eq(files.id, input.id), eq(files.userId, input.userId)))
			.limit(1);
		if (!row) return false;
		await this.database.delete(files).where(eq(files.id, input.id));
		await this.database
			.delete(filePayloads)
			.where(eq(filePayloads.storageRef, row.storageRef));
		return true;
	}
}

export class PostgresArtifactStore implements ArtifactStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertWorkflowArtifact(input: WorkflowArtifactInput): Promise<{ id: string }> {
		const [execution] = await this.database
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, input.workflowExecutionId))
			.limit(1);
		if (!execution) throw new Error(`execution ${input.workflowExecutionId} not found`);

		await this.database
			.insert(workflowArtifacts)
			.values({
				id: input.id,
				workflowExecutionId: input.workflowExecutionId,
				nodeId: input.nodeId ?? null,
				slot: input.slot ?? null,
				kind: input.kind,
				title: input.title,
				description: input.description ?? null,
				inlinePayload: input.inlinePayload ?? null,
				fileId: input.fileId ?? null,
				contentType: input.contentType ?? null,
				sizeBytes: input.sizeBytes ?? null,
				metadata: input.metadata ?? null,
			})
			.onConflictDoUpdate({
				target: workflowArtifacts.id,
				set: {
					nodeId: input.nodeId ?? null,
					slot: input.slot ?? null,
					kind: input.kind,
					title: input.title,
					description: input.description ?? null,
					inlinePayload: input.inlinePayload ?? null,
					fileId: input.fileId ?? null,
					contentType: input.contentType ?? null,
					sizeBytes: input.sizeBytes ?? null,
					metadata: input.metadata ?? null,
				},
			});
		return { id: input.id };
	}

	async listWorkflowArtifactsByExecutionId(executionId: string): Promise<WorkflowArtifactRecord[]> {
		const rows = await this.database
			.select()
			.from(workflowArtifacts)
			.where(eq(workflowArtifacts.workflowExecutionId, executionId))
			.orderBy(SLOT_RANK, asc(workflowArtifacts.createdAt));
		return rows.map(mapArtifact);
	}

	async listSourceBundleArtifactsByWorkflowId(workflowId: string): Promise<WorkflowArtifactRecord[]> {
		const executions = await this.database
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(eq(workflowExecutions.workflowId, workflowId));
		if (executions.length === 0) return [];
		const rows = await this.database
			.select()
			.from(workflowArtifacts)
			.where(
				and(
					inArray(
						workflowArtifacts.workflowExecutionId,
						executions.map((execution) => execution.id),
					),
					eq(workflowArtifacts.kind, SOURCE_BUNDLE_KIND),
				),
			)
			.orderBy(desc(workflowArtifacts.createdAt));
		return rows.map(mapArtifact);
	}

	async getWorkflowArtifactForExecution(input: {
		executionId: string;
		artifactId: string;
	}): Promise<WorkflowArtifactRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowArtifacts)
			.where(
				and(
					eq(workflowArtifacts.id, input.artifactId),
					eq(workflowArtifacts.workflowExecutionId, input.executionId),
				),
			)
			.limit(1);
		return row ? mapArtifact(row) : null;
	}

	async updateWorkflowArtifactMetadata(input: {
		executionId: string;
		artifactId: string;
		metadata: Record<string, unknown> | null;
	}): Promise<WorkflowArtifactRecord | null> {
		const [row] = await this.database
			.update(workflowArtifacts)
			.set({ metadata: input.metadata })
			.where(
				and(
					eq(workflowArtifacts.id, input.artifactId),
					eq(workflowArtifacts.workflowExecutionId, input.executionId),
				),
			)
			.returning();
		return row ? mapArtifact(row) : null;
	}
}

export class PostgresWorkspaceSessionStore implements WorkspaceSessionStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertWorkflowWorkspaceSession(
		input: UpsertWorkspaceSessionInput,
	): Promise<{ workspaceRef: string }> {
		await this.database
			.insert(workflowWorkspaceSessions)
			.values({
				workspaceRef: input.workspaceRef,
				workflowExecutionId: input.workflowExecutionId ?? null,
				durableInstanceId: input.durableInstanceId ?? null,
				name: input.name,
				rootPath: input.rootPath,
				clonePath: input.clonePath ?? null,
				backend: input.backend,
				enabledTools: input.enabledTools ?? [],
				status: input.status ?? "active",
				sandboxState: input.sandboxState ?? null,
			})
			.onConflictDoUpdate({
				target: workflowWorkspaceSessions.workspaceRef,
				set: {
					workflowExecutionId: input.workflowExecutionId ?? null,
					durableInstanceId: input.durableInstanceId ?? null,
					name: input.name,
					rootPath: input.rootPath,
					clonePath: input.clonePath ?? null,
					backend: input.backend,
					enabledTools: input.enabledTools ?? [],
					status: input.status ?? "active",
					sandboxState: input.sandboxState ?? null,
					updatedAt: new Date(),
					lastAccessedAt: new Date(),
				},
			});
		return { workspaceRef: input.workspaceRef };
	}
}

export class PostgresWorkflowAgentRunStore implements WorkflowAgentRunStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertScheduledAgentRun(
		input: UpsertWorkflowAgentRunScheduledInput,
	): Promise<{ id: string }> {
		await this.database
			.insert(workflowAgentRuns)
			.values({
				id: input.id,
				workflowExecutionId: input.workflowExecutionId,
				workflowId: input.workflowId,
				nodeId: input.nodeId,
				mode: input.mode,
				agentWorkflowId: input.agentWorkflowId,
				daprInstanceId: input.daprInstanceId,
				parentExecutionId: input.parentExecutionId,
				workspaceRef: input.workspaceRef ?? null,
				artifactRef: input.artifactRef ?? null,
				status: "scheduled",
			})
			.onConflictDoUpdate({
				target: workflowAgentRuns.id,
				set: {
					workflowExecutionId: input.workflowExecutionId,
					workflowId: input.workflowId,
					nodeId: input.nodeId,
					mode: input.mode,
					agentWorkflowId: input.agentWorkflowId,
					daprInstanceId: input.daprInstanceId,
					parentExecutionId: input.parentExecutionId,
					workspaceRef: input.workspaceRef ?? null,
					artifactRef: input.artifactRef ?? null,
					status: "scheduled",
					updatedAt: new Date(),
				},
			});

		if (input.workspaceRef) {
			await this.database
				.update(workflowWorkspaceSessions)
				.set({
					durableInstanceId: input.daprInstanceId,
					updatedAt: new Date(),
					lastAccessedAt: new Date(),
				})
				.where(eq(workflowWorkspaceSessions.workspaceRef, input.workspaceRef));
		}

		return { id: input.id };
	}

	async updateAgentRunLifecycle(
		input: UpdateWorkflowAgentRunLifecycleInput,
	): Promise<{ id: string; status: "scheduled" | "running" | "completed" | "failed" | "event_published" }> {
		if (input.status === "running") {
			await this.database
				.update(workflowAgentRuns)
				.set({
					status: "running",
					...(input.result != null ? { result: input.result } : {}),
					updatedAt: new Date(),
				})
				.where(eq(workflowAgentRuns.id, input.id));
		} else {
			await this.database
				.update(workflowAgentRuns)
				.set({
					status: input.status,
					result: input.result ?? null,
					error: input.error ?? null,
					...(input.workspaceRef ? { workspaceRef: input.workspaceRef } : {}),
					completedAt: sql`COALESCE(${workflowAgentRuns.completedAt}, now())`,
					...(input.eventPublished ? { eventPublishedAt: new Date() } : {}),
					updatedAt: new Date(),
				})
				.where(eq(workflowAgentRuns.id, input.id));
		}

		return { id: input.id, status: input.status };
	}
}

export class PostgresWorkflowPlanArtifactStore implements WorkflowPlanArtifactStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async upsertPlanArtifact(input: WorkflowPlanArtifactInput): Promise<{
		artifactRef: string;
		storageBackend: "workflow_plan_artifacts";
		artifactType: string;
		status: "draft" | "approved" | "superseded" | "executed" | "failed";
	}> {
		const [execution] = await this.database
			.select({
				userId: workflowExecutions.userId,
				workflowId: workflowExecutions.workflowId,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, input.workflowExecutionId))
			.limit(1);
		if (!execution) throw new Error(`execution ${input.workflowExecutionId} not found`);

		const artifactType = input.artifactType?.trim() || "claude_task_graph_v1";
		const status = input.status ?? "draft";
		await this.database
			.insert(workflowPlanArtifacts)
			.values({
				id: input.artifactRef,
				workflowExecutionId: input.workflowExecutionId,
				workflowId: execution.workflowId ?? input.workflowId,
				userId: execution.userId ?? null,
				nodeId: input.nodeId,
				workspaceRef: input.workspaceRef ?? null,
				clonePath: input.clonePath ?? null,
				artifactType: artifactType as "claude_task_graph_v1",
				artifactVersion: 1,
				status,
				goal: input.goal,
				planJson: input.planJson,
				planMarkdown: input.planMarkdown ?? null,
				sourcePrompt: input.sourcePrompt ?? null,
				metadata: input.metadata ?? null,
			})
			.onConflictDoUpdate({
				target: workflowPlanArtifacts.id,
				set: {
					status,
					goal: input.goal,
					planJson: input.planJson,
					planMarkdown: input.planMarkdown ?? null,
					sourcePrompt: input.sourcePrompt ?? null,
					metadata: input.metadata ?? null,
					workspaceRef: input.workspaceRef ?? null,
					clonePath: input.clonePath ?? null,
					updatedAt: new Date(),
				},
			});

		return {
			artifactRef: input.artifactRef,
			storageBackend: "workflow_plan_artifacts",
			artifactType,
			status,
		};
	}

	async listPlanArtifactsByExecutionId(executionId: string): Promise<WorkflowPlanArtifactRecord[]> {
		const rows = await this.database
			.select()
			.from(workflowPlanArtifacts)
			.where(eq(workflowPlanArtifacts.workflowExecutionId, executionId))
			.orderBy(desc(workflowPlanArtifacts.createdAt));
		return rows.map(mapPlanArtifact);
	}

	async updatePlanArtifactStatus(input: {
		artifactRef: string;
		status: "draft" | "approved" | "superseded" | "executed" | "failed";
		metadata?: Record<string, unknown> | null;
	}): Promise<{ artifactRef: string; status: "draft" | "approved" | "superseded" | "executed" | "failed" }> {
		const [row] = await this.database
			.update(workflowPlanArtifacts)
			.set({
				status: input.status,
				...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
				updatedAt: new Date(),
			})
			.where(eq(workflowPlanArtifacts.id, input.artifactRef))
			.returning({ id: workflowPlanArtifacts.id });
		if (!row) throw new Error(`plan artifact ${input.artifactRef} not found`);
		return { artifactRef: input.artifactRef, status: input.status };
	}

	async getPlanArtifact(artifactRef: string): Promise<WorkflowPlanArtifactRecord | null> {
		const [row] = await this.database
			.select()
			.from(workflowPlanArtifacts)
			.where(eq(workflowPlanArtifacts.id, artifactRef))
			.limit(1);
		return row ? mapPlanArtifact(row) : null;
	}
}

export class PostgresTraceLineageStore implements TraceLineageStore {
	constructor(private readonly database: Database = requirePostgresDb()) {}

	async getTraceTargetsForExecution(executionId: string): Promise<TraceLinkTarget[]> {
		const targets: TraceLinkTarget[] = [];
		const [execution] = await this.database
			.select({
				id: workflowExecutions.id,
				projectId: workflowExecutions.projectId,
				externalExperimentId: workflowExecutions.mlflowExperimentId,
				externalRunId: workflowExecutions.mlflowRunId,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.id, executionId))
			.limit(1);
		if (execution) {
			targets.push({
				entityType: "workflow_execution",
				entityId: execution.id,
				projectId: execution.projectId,
				externalExperimentId: execution.externalExperimentId,
				externalRunId: execution.externalRunId,
			});
		}

		const sessionRows = await this.database
			.select({
				id: sessions.id,
				projectId: sessions.projectId,
				externalExperimentId: sessions.mlflowExperimentId,
				externalRunId: sessions.mlflowRunId,
			})
			.from(sessions)
			.where(eq(sessions.workflowExecutionId, executionId));
		for (const row of sessionRows) {
			targets.push({
				entityType: "session",
				entityId: row.id,
				projectId: row.projectId,
				externalExperimentId: row.externalExperimentId,
				externalRunId: row.externalRunId,
			});
		}

		const seen = new Set<string>();
		return targets.filter((target) => {
			const key = `${target.entityType}:${target.entityId}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	}

	async upsertTraceLineageLinks(
		input: UpsertTraceLineageLinksInput,
	): Promise<{ recorded: number; sourceKeys: string[] }> {
		const source = input.source?.trim() || "primary";
		const sourceKeys: string[] = [];
		for (const target of input.targets) {
			if (!target.entityType || !target.entityId) continue;
			const sourceKey = `${target.entityType}:${target.entityId}:otel_trace:${input.traceId}:source:${source}`;
			await this.database
				.insert(mlflowLineageLinks)
				.values({
					sourceKey,
					entityType: target.entityType,
					entityId: target.entityId,
					projectId: target.projectId ?? null,
					mlflowEntityType: "otel_trace",
					mlflowExperimentId: target.externalExperimentId ?? null,
					mlflowRunId: target.externalRunId ?? null,
					mlflowTraceId: input.traceId,
					tags: input.attrs ?? {},
					metadata: { source, telemetrySystem: "opentelemetry" },
				})
				.onConflictDoUpdate({
					target: mlflowLineageLinks.sourceKey,
					set: {
						projectId: target.projectId ?? null,
						mlflowExperimentId: target.externalExperimentId ?? null,
						mlflowRunId: target.externalRunId ?? null,
						mlflowTraceId: input.traceId,
						tags: input.attrs ?? {},
						metadata: { source, telemetrySystem: "opentelemetry" },
						updatedAt: new Date(),
					},
				});
			sourceKeys.push(sourceKey);
		}
		return { recorded: sourceKeys.length, sourceKeys };
	}
}
