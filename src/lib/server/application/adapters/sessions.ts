import type {
	AddSessionResourceInput,
  AcknowledgeRuntimeProvisioningCompensationInput,
  AuthorizeSessionRuntimeStartInput,
	AttachSessionRuntimeInput,
  CompleteSessionRuntimeHostRecoveryResult,
	CliWorkspaceSessionCandidateRecord,
	CreateSessionForkInput,
  CreatePeerSessionResult,
	CreateSessionRecordInput,
	EnsureSessionRecordInput,
	EnsureSessionRecordResult,
	CreatePeerSessionInput,
	CreateSessionGoalInput,
	GoalLoopStore,
	CreateWorkflowEnsureSessionInput,
	LivenessReconcileCandidateRecord,
	PeerSessionRecord,
  ReserveSessionRuntimeProvisioningInput,
  RuntimeProvisioningLease,
  StageSessionRuntimeProvisioningInput,
  StaleSessionRuntimeProvisioningTarget,
  SessionRuntimeHostRecoveryLease,
  SessionRuntimeHostRecoveryRecord,
  SessionRuntimeStartAuthorizationResult,
	SessionAgentConfigCommandPort,
	SessionAgentConfigPatchResult,
	SessionBrowserTarget,
	SessionContextUsageReadModel,
	SessionEventLog,
	SessionGoalHarnessResolver,
	SessionGoalLoopDriver,
	SessionGoalRecord,
	SessionGoalScopeGuard,
	SessionGoalStore,
	SandboxSessionOwnerRecord,
	SessionCoordinatorOwnerPort,
	SessionLifecycleController,
	SessionLifecycleStopMode,
	SessionProvisioningContext,
	SessionProvisioningReader,
	SessionRepository,
	SessionRepositoryMountTarget,
	SessionRepositoryMounter,
	SessionRuntimeDebugTarget,
	SessionRuntimeTarget,
	SessionRuntimeConfigReader,
	SessionRuntimeEventRaiser,
  SessionUserEventAcceptance,
	SessionSandboxDeleteResult,
	SessionSandboxDestroyer,
	SessionUserEventCommandPort,
	SessionListInput,
	SessionWorkflowSpawner,
	SessionWorkflowContext,
  TeamMailboxDeliveryMetadata,
	WorkflowDataService,
	UpdateSessionStatusInput,
	UpdateSessionStatusUnlessTerminatedInput,
	UpdateWorkflowEnsureSessionRuntimeInput,
	WorkflowEnsureSessionRecord,
	WorkflowExecutionSessionRuntimeRecord,
	WorkflowSessionRuntimeHostRecord,
} from "$lib/server/application/ports";
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { toPostgresTimestampParam } from "$lib/server/db/sql-params";
import {
	agents,
	benchmarkRunInstances,
	evaluationRunItems,
	projects,
	sessionEvents,
	sessionResources,
	sessions,
	threadGoals,
	workflowScriptCalls,
	workflowExecutions,
	workflows,
	type Session,
	type SessionResource as SessionResourceRow,
} from "$lib/server/db/schema";
import { resolveAgentRef } from "$lib/server/application/adapters/agent-registry";
import { raiseSessionAgentConfigPatch as raiseSessionAgentConfigPatchForRuntime } from "$lib/server/sessions/agent-config-patch";
import { getSessionProvisioningPreferObserver } from "$lib/server/sessions/provisioning";
import {
	getSessionRuntimeConfig,
	RUNTIME_CONFIG_SESSION_EVENT_TYPE,
} from "$lib/server/sessions/runtime-config";
import {
	raiseSessionUserEvents,
  releaseSessionWorkflow,
  reserveSessionWorkflow,
	spawnSessionWorkflow,
} from "$lib/server/sessions/spawn";
import {
	mountSessionRepositories,
	mountSessionRepositoriesViaHost,
	mountSingleRepository,
} from "$lib/server/application/adapters/session-repositories";
import { openshellRuntimeFetch } from "$lib/server/openshell-runtime";
import { deleteKubernetesSandbox } from "$lib/server/kube/client";
import {
	confirmDurableStop,
	inspectDurableRun,
	stopDurableRun,
	type StopDurableRunMode,
} from "$lib/server/lifecycle";
import { pauseDurableRun, resumeDurableRun } from "$lib/server/lifecycle/pause";
import { PostgresGoalLoopStore } from "$lib/server/application/adapters/goal-loop-store";
import { PostgresLifecycleCoordinatorOwnerStore } from "$lib/server/application/adapters/lifecycle-ownership";
import { isResourceInScope } from "$lib/server/workflows/project-scope";
import { kickGoalLoop } from "$lib/server/goals/goal-loop";
import {
	decideGoalHarness,
	runtimeHasNativeGoalHarness,
} from "$lib/server/sessions/goal-harness";
import {
	DEFAULT_RUNTIME_ID,
	getRuntimeDescriptor,
} from "$lib/server/agents/runtime-registry";
import {
	agentRuntimeDedicatedAppId,
	agentRuntimeInvokeTarget,
} from "$lib/server/agents/runtime-routing";
import type {
	PendingInput,
	SessionDetail,
	SessionResource,
	SessionResourceType,
	SessionStatus,
	SessionStopReason,
	SessionSummary,
	SessionUsage,
	UserEvent,
} from "$lib/types/sessions";

type Database = typeof defaultDb;

function activeProvisioningParentWorkflow(): SQL {
  return sql`(
    ${sessions.workflowExecutionId} IS NULL
    OR EXISTS (
      SELECT 1
      FROM ${workflowExecutions}
      WHERE ${workflowExecutions.id} = ${sessions.workflowExecutionId}
        AND ${workflowExecutions.status} IN ('pending', 'running')
        AND ${workflowExecutions.stopRequestedAt} IS NULL
        AND ${workflowExecutions.completedAt} IS NULL
    )
  )`;
}

function activeProvisioningParentSession(): SQL {
  return sql`(
    ${sessions.parentExecutionId} IS NULL
    OR EXISTS (
      SELECT 1
      FROM ${sessions} AS parent_session
      WHERE parent_session.id = ${sessions.parentExecutionId}
        AND parent_session.status IN ('rescheduling', 'running', 'idle')
        AND parent_session.stop_requested_at IS NULL
        AND parent_session.completed_at IS NULL
    )
  )`;
}

function runtimeProvisioningCompensationAuthority(): SQL {
  return sql`(
		${sessions.stopRequestedAt} IS NOT NULL
		OR ${sessions.completedAt} IS NOT NULL
		OR ${sessions.status} = 'terminated'
		OR (
			${sessions.workflowExecutionId} IS NOT NULL
			AND NOT EXISTS (
				SELECT 1
				FROM ${workflowExecutions}
				WHERE ${workflowExecutions.id} = ${sessions.workflowExecutionId}
					AND ${workflowExecutions.status} IN ('pending', 'running')
					AND ${workflowExecutions.stopRequestedAt} IS NULL
					AND ${workflowExecutions.completedAt} IS NULL
			)
		)
		OR (
			${sessions.parentExecutionId} IS NOT NULL
			AND NOT EXISTS (
				SELECT 1
				FROM ${sessions} AS compensation_parent_session
				WHERE compensation_parent_session.id = ${sessions.parentExecutionId}
					AND compensation_parent_session.status <> 'terminated'
					AND compensation_parent_session.stop_requested_at IS NULL
					AND compensation_parent_session.completed_at IS NULL
			)
		)
	)`;
}

function requireDb(database: Database = defaultDb): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

function toPeerSessionRecord(session: Session): PeerSessionRecord {
	return {
		id: session.id,
    status: session.status as SessionStatus,
		agentId: session.agentId,
		agentVersion: session.agentVersion,
		environmentId: session.environmentId,
		environmentVersion: session.environmentVersion,
		vaultIds: session.vaultIds,
		daprInstanceId: session.daprInstanceId,
		natsSubject: session.natsSubject,
		runtimeAppId: session.runtimeAppId,
    runtimeProvisioningStartedAt: session.runtimeProvisioningStartedAt,
    workflowExecutionId: session.workflowExecutionId,
    parentExecutionId: session.parentExecutionId,
    stopRequestedAt: session.stopRequestedAt,
    completedAt: session.completedAt,
	};
}

function toSessionResource(row: SessionResourceRow): SessionResource {
	return {
		id: row.id,
		sessionId: row.sessionId,
		type: row.type as SessionResourceType,
		fileId: row.fileId ?? null,
		mountPath: row.mountPath ?? null,
		repoUrl: row.repoUrl ?? null,
		checkoutRef: row.checkoutRef ?? null,
		authTokenCredentialId: row.authTokenCredentialId ?? null,
		appConnectionExternalId: row.appConnectionExternalId ?? null,
		mountedAt: row.mountedAt ? row.mountedAt.toISOString() : null,
		removedAt: row.removedAt ? row.removedAt.toISOString() : null,
	};
}

type SessionJoinContext = {
	workflowId: string | null;
	workflowName: string | null;
	agentName: string | null;
	agentSlug: string | null;
	agentAvatar: string | null;
	agentTags: string[] | null;
};

const EMPTY_SESSION_CONTEXT: SessionJoinContext = {
	workflowId: null,
	workflowName: null,
	agentName: null,
	agentSlug: null,
	agentAvatar: null,
	agentTags: null,
};

function rowToSessionSummary(
	row: Session,
	ctx: SessionJoinContext = EMPTY_SESSION_CONTEXT,
): SessionSummary {
	const agentTags = Array.isArray(ctx.agentTags) ? ctx.agentTags : [];
	return {
		id: row.id,
		title: row.title ?? null,
		status: row.status as SessionStatus,
		stopReason: (row.stopReason as SessionStopReason | null) ?? null,
		agentId: row.agentId,
		agentVersion: row.agentVersion ?? null,
		projectId: row.projectId ?? null,
		environmentId: row.environmentId ?? null,
		environmentVersion: row.environmentVersion ?? null,
		vaultIds: Array.isArray(row.vaultIds) ? row.vaultIds : [],
		usage: (row.usage as SessionUsage) ?? {},
		errorMessage: row.errorMessage ?? null,
		workflowExecutionId: row.workflowExecutionId ?? null,
		mlflowExperimentId: row.mlflowExperimentId ?? null,
		mlflowRunId: row.mlflowRunId ?? null,
		mlflowParentRunId: row.mlflowParentRunId ?? null,
		mlflowSessionId: row.mlflowSessionId ?? null,
		workflowId: ctx.workflowId,
		workflowName: ctx.workflowName,
		agentName: ctx.agentName,
		agentSlug: ctx.agentSlug,
		agentAvatar: ctx.agentAvatar,
		agentEphemeral: agentTags.includes("workflow-ephemeral"),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
		pendingInput: (row.pendingInput as PendingInput | null) ?? null,
		completedAt: row.completedAt ? row.completedAt.toISOString() : null,
		archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
	};
}

function rowToSessionDetail(
	row: Session,
	ctx: SessionJoinContext = EMPTY_SESSION_CONTEXT,
): SessionDetail {
	return {
		...rowToSessionSummary(row, ctx),
		daprInstanceId: row.daprInstanceId ?? null,
		natsSubject: row.natsSubject ?? null,
		parentExecutionId: row.parentExecutionId ?? null,
		resumedFromSessionId: row.resumedFromSessionId ?? null,
		sandboxName: row.sandboxName ?? null,
		workspaceSandboxName: row.workspaceSandboxName ?? null,
		runtimeAppId: row.runtimeAppId ?? null,
		runtimeSandboxName: row.runtimeSandboxName ?? null,
		pausedAt: row.pauseRequestedAt ? row.pauseRequestedAt.toISOString() : null,
	};
}

/**
 * Default Dapr app that executes direct `durable/run` sessions. The sandbox
 * detail UI filters on `sessions.sandbox_name`, so new UI-created sessions keep
 * the historical default unless a caller overrides it.
 */
const DEFAULT_SANDBOX_NAME = "dapr-agent-py";

// In-process throttle for the liveness `last_event_at` bump. Every ingested
// event calls bumpSessionLastEventAt; the SQL WHERE already caps the write to one
// per 5s window, but ISSUING the UPDATE still costs a round-trip. This gate skips
// the statement entirely when THIS pod bumped the session inside the window. The
// SQL guard remains the cross-pod correctness backstop; this is a pure hot-path
// optimization. Bounded via a periodic sweep so the map can't grow unboundedly.
const LAST_EVENT_BUMP_WINDOW_MS = 5_000;
const LAST_EVENT_BUMP_SWEEP_MS = 60_000;
const lastEventBumpAt = new Map<string, number>();
let lastEventBumpSweepAt = 0;

function shouldSkipLastEventBump(sessionId: string, nowMs: number): boolean {
	const prev = lastEventBumpAt.get(sessionId);
  if (prev !== undefined && nowMs - prev < LAST_EVENT_BUMP_WINDOW_MS)
    return true;
	lastEventBumpAt.set(sessionId, nowMs);
	if (nowMs - lastEventBumpSweepAt > LAST_EVENT_BUMP_SWEEP_MS) {
		lastEventBumpSweepAt = nowMs;
		for (const [id, ts] of lastEventBumpAt) {
			if (nowMs - ts >= LAST_EVENT_BUMP_WINDOW_MS) lastEventBumpAt.delete(id);
		}
	}
	return false;
}

export class CurrentSessionRepository implements SessionRepository {
  constructor(
    private readonly database?: Database,
    private readonly resolveAgent: typeof resolveAgentRef = resolveAgentRef,
  ) {}

	async listSessions(filter: SessionListInput = {}) {
		const database = requireDb(this.database);
		type SqlCondition = ReturnType<typeof eq>;
		const conditions: SqlCondition[] = [];
		if (filter.userId) conditions.push(eq(sessions.userId, filter.userId));
    if (filter.projectId)
      conditions.push(eq(sessions.projectId, filter.projectId));
		if (filter.agentId) conditions.push(eq(sessions.agentId, filter.agentId));
		if (filter.status) conditions.push(eq(sessions.status, filter.status));
		if (filter.source === "direct") {
			conditions.push(
				sql`${sessions.workflowExecutionId} IS NULL` as unknown as SqlCondition,
			);
		} else if (filter.source === "workflow") {
			conditions.push(
				sql`${sessions.workflowExecutionId} IS NOT NULL` as unknown as SqlCondition,
			);
		}
		if (filter.executionId) {
			conditions.push(eq(sessions.workflowExecutionId, filter.executionId));
		}
		if (filter.workflowId) {
			conditions.push(eq(workflowExecutions.workflowId, filter.workflowId));
		}
		if (filter.q && filter.q.trim().length >= 2) {
			const needle = `%${filter.q.trim()}%`;
			const textCondition = or(
				ilike(sessions.title, needle),
				ilike(sessions.id, needle),
				ilike(workflows.name, needle),
				ilike(agents.name, needle),
			);
			if (textCondition) conditions.push(textCondition as SqlCondition);
		}
		if (!filter.includeArchived) {
      conditions.push(
        sql`${sessions.archivedAt} IS NULL` as unknown as SqlCondition,
      );
		}

		const rows = await database
			.select({
				session: sessions,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				agentName: agents.name,
				agentSlug: agents.slug,
				agentAvatar: agents.avatar,
				agentTags: agents.tags,
			})
			.from(sessions)
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, sessions.workflowExecutionId),
			)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.leftJoin(agents, eq(agents.id, sessions.agentId))
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(sessions.createdAt))
			.limit(filter.limit ?? 100)
			.offset(filter.offset ?? 0);
		return rows.map((row) =>
			rowToSessionSummary(row.session, {
				workflowId: row.workflowId ?? null,
				workflowName: row.workflowName ?? null,
				agentName: row.agentName ?? null,
				agentSlug: row.agentSlug ?? null,
				agentAvatar: row.agentAvatar ?? null,
				agentTags: (row.agentTags as string[] | null) ?? null,
			}),
		);
	}

	async getSession(id: string): Promise<SessionDetail | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({
				session: sessions,
				workflowId: workflowExecutions.workflowId,
				workflowName: workflows.name,
				agentName: agents.name,
				agentSlug: agents.slug,
				agentAvatar: agents.avatar,
				agentTags: agents.tags,
			})
			.from(sessions)
			.leftJoin(
				workflowExecutions,
				eq(workflowExecutions.id, sessions.workflowExecutionId),
			)
			.leftJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.leftJoin(agents, eq(agents.id, sessions.agentId))
			.where(eq(sessions.id, id))
			.limit(1);
		return row
			? rowToSessionDetail(row.session, {
					workflowId: row.workflowId ?? null,
					workflowName: row.workflowName ?? null,
					agentName: row.agentName ?? null,
					agentSlug: row.agentSlug ?? null,
					agentAvatar: row.agentAvatar ?? null,
					agentTags: (row.agentTags as string[] | null) ?? null,
				})
			: null;
	}

	async createSession(input: CreateSessionRecordInput): Promise<SessionDetail> {
		const database = requireDb(this.database);
    const resolvedAgent = await this.resolveAgent({
			id: input.agentId,
			version: input.agentVersion,
		});
		if (!resolvedAgent) {
			throw new Error(`Agent ${input.agentId} not found`);
		}

		const environmentId = input.environmentId ?? resolvedAgent.environmentId;
		const environmentVersion =
			input.environmentVersion ?? resolvedAgent.environmentVersion ?? null;
		const vaultIds =
			input.vaultIds ??
			(resolvedAgent.defaultVaultIds.length > 0
				? resolvedAgent.defaultVaultIds
				: []);

		const values = {
			...(input.id ? { id: input.id } : {}),
			title: input.title ?? null,
			status: "rescheduling" as const,
			agentId: resolvedAgent.id,
			agentVersion: resolvedAgent.version,
			environmentId: environmentId ?? null,
			environmentVersion,
			vaultIds,
			userId: input.userId,
			projectId: input.projectId ?? null,
			sandboxName: input.sandboxName ?? DEFAULT_SANDBOX_NAME,
			workflowExecutionId: input.workflowExecutionId ?? null,
			parentExecutionId: input.parentExecutionId ?? null,
			resumedFromSessionId: input.resumedFromSessionId ?? null,
			mlflowSessionId: input.id ?? null,
		};
		const [row] = await database.insert(sessions).values(values).returning();
		if (!row.mlflowSessionId) {
			const [updated] = await database
				.update(sessions)
				.set({ mlflowSessionId: row.id, updatedAt: row.updatedAt })
				.where(eq(sessions.id, row.id))
				.returning();
			return rowToSessionDetail(updated ?? row);
		}
		return rowToSessionDetail(row);
	}

  async ensureSession(
    input: EnsureSessionRecordInput,
  ): Promise<EnsureSessionRecordResult> {
		const database = requireDb(this.database);
    const resolvedAgent = await this.resolveAgent({
			id: input.agentId,
			version: input.agentVersion,
		});
		if (!resolvedAgent) {
			throw new Error(`Agent ${input.agentId} not found`);
		}

		const environmentId = input.environmentId ?? resolvedAgent.environmentId;
		const environmentVersion =
			input.environmentVersion ?? resolvedAgent.environmentVersion ?? null;
		const vaultIds =
			input.vaultIds ??
      (resolvedAgent.defaultVaultIds.length > 0
        ? resolvedAgent.defaultVaultIds
        : []);
		const values = {
			id: input.id,
			title: input.title ?? null,
			status: "rescheduling" as const,
			agentId: resolvedAgent.id,
			agentVersion: resolvedAgent.version,
			environmentId: environmentId ?? null,
			environmentVersion,
			vaultIds,
			userId: input.userId,
			projectId: input.projectId ?? null,
			sandboxName: input.sandboxName ?? DEFAULT_SANDBOX_NAME,
			workflowExecutionId: input.workflowExecutionId ?? null,
			parentExecutionId: input.parentExecutionId ?? null,
			resumedFromSessionId: input.resumedFromSessionId ?? null,
			mlflowSessionId: input.id,
		};
		const [inserted] = await database
			.insert(sessions)
			.values(values)
			.onConflictDoNothing({ target: sessions.id })
			.returning();
		if (inserted) {
			return { session: rowToSessionDetail(inserted), created: true };
		}

		const existing = await this.getSession(input.id);
		if (!existing) {
			throw new Error(`Session ${input.id} conflicted but could not be loaded`);
		}
		return { session: existing, created: false };
	}

  async updateSessionTitle(input: {
    id: string;
    title: string;
  }): Promise<SessionDetail | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.update(sessions)
			.set({ title: input.title, updatedAt: new Date() })
			.where(eq(sessions.id, input.id))
			.returning({ id: sessions.id });
		return row ? this.getSession(row.id) : null;
	}

	async archiveSession(id: string): Promise<boolean> {
		const database = requireDb(this.database);
		const archivedAt = new Date();
		const [row] = await database
			.update(sessions)
			.set({ archivedAt, updatedAt: archivedAt })
			.where(eq(sessions.id, id))
			.returning({ id: sessions.id });
		return Boolean(row);
	}

	async deleteSession(id: string): Promise<boolean> {
		const database = requireDb(this.database);
		const [row] = await database
			.delete(sessions)
			.where(eq(sessions.id, id))
			.returning({ id: sessions.id });
		return Boolean(row);
	}

	async listSessionResources(sessionId: string): Promise<SessionResource[]> {
		const database = requireDb(this.database);
		const rows = await database
			.select()
			.from(sessionResources)
			.where(eq(sessionResources.sessionId, sessionId))
			.orderBy(asc(sessionResources.mountPath));
		return rows.map(toSessionResource);
	}

	async addSessionResource(input: {
		sessionId: string;
		resource: AddSessionResourceInput;
	}): Promise<SessionResource> {
		const database = requireDb(this.database);
		const [row] = await database
			.insert(sessionResources)
			.values({
				sessionId: input.sessionId,
				type: input.resource.type,
				fileId: input.resource.fileId ?? null,
				mountPath: input.resource.mountPath ?? null,
				repoUrl: input.resource.repoUrl ?? null,
				checkoutRef: input.resource.checkoutRef ?? null,
				authTokenCredentialId: input.resource.authTokenCredentialId ?? null,
				appConnectionExternalId: input.resource.appConnectionExternalId ?? null,
			})
			.returning();
		return toSessionResource(row);
	}

	async attachWorkspaceSandbox(input: {
		sessionId: string;
		workspaceSandboxName: string;
  }): Promise<boolean> {
		const database = requireDb(this.database);
    const attached = await database
			.update(sessions)
			.set({
				workspaceSandboxName: input.workspaceSandboxName,
				errorMessage: null,
				updatedAt: new Date(),
			})
      .where(eq(sessions.id, input.sessionId))
      .returning({
        id: sessions.id,
        status: sessions.status,
        completedAt: sessions.completedAt,
        stopRequestedAt: sessions.stopRequestedAt,
      });
    const row = attached[0];
    return Boolean(
      row &&
      row.status !== "terminated" &&
      row.completedAt == null &&
      row.stopRequestedAt == null,
    );
	}

	async recordSandboxProvisioningError(input: {
		sessionId: string;
		errorMessage: string;
	}): Promise<void> {
		const database = requireDb(this.database);
		await database
			.update(sessions)
			.set({ errorMessage: input.errorMessage, updatedAt: new Date() })
			.where(eq(sessions.id, input.sessionId));
	}

	async removeSessionResource(input: {
		sessionId: string;
		resourceId: string;
	}): Promise<boolean> {
		const database = requireDb(this.database);
		const [row] = await database
			.delete(sessionResources)
			.where(
				and(
					eq(sessionResources.sessionId, input.sessionId),
					eq(sessionResources.id, input.resourceId),
				),
			)
			.returning({ id: sessionResources.id });
		return Boolean(row);
	}

	async getSessionProvisioningContext(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionProvisioningContext | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({
				id: sessions.id,
				status: sessions.status,
				runtimeAppId: sessions.runtimeAppId,
				projectId: sessions.projectId,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.id, input.sessionId),
					input.projectId ? eq(sessions.projectId, input.projectId) : undefined,
				),
			)
			.limit(1);
		return row
			? {
					id: row.id,
					status: row.status as SessionProvisioningContext["status"],
					runtimeAppId: row.runtimeAppId ?? null,
					projectId: row.projectId ?? null,
				}
			: null;
	}

	async getSessionContextUsage(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionContextUsageReadModel | null> {
		const database = requireDb(this.database);
		const [session] = await database
			.select({
				id: sessions.id,
				usage: sessions.usage,
			})
			.from(sessions)
			.where(
				and(
					eq(sessions.id, input.sessionId),
					input.projectId ? eq(sessions.projectId, input.projectId) : undefined,
				),
			)
			.limit(1);
		if (!session) return null;

		const [{ eventCount, totalBytes, turns }] = await database
			.select({
				eventCount: sql<number>`count(*)`,
				totalBytes: sql<number>`coalesce(sum(length(data::text)), 0)`,
				turns: sql<number>`coalesce(nullif(count(*) filter (where type = 'agent.llm_usage'), 0), count(*) filter (where type = 'span.model_request_end'))`,
			})
			.from(sessionEvents)
			.where(eq(sessionEvents.sessionId, input.sessionId));
		const [activeContext] = await database
			.select({ data: sessionEvents.data })
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, input.sessionId),
					eq(sessionEvents.type, "agent.context_usage"),
				),
			)
			.orderBy(desc(sessionEvents.sequence))
			.limit(1);
		const [lastProviderContext] = await database
			.select({ data: sessionEvents.data })
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, input.sessionId),
					eq(sessionEvents.type, "agent.llm_usage"),
				),
			)
			.orderBy(desc(sessionEvents.sequence))
			.limit(1);

		return {
			sessionId: session.id,
			usage: (session.usage as SessionContextUsageReadModel["usage"]) ?? {},
			activeContext: recordOrNull(activeContext?.data),
			lastProviderContext: recordOrNull(lastProviderContext?.data),
			events: {
				total: Number(eventCount ?? 0),
				totalBytes: Number(totalBytes ?? 0),
				llmTurns: Number(turns ?? 0),
			},
		};
	}

	async getSessionOwnerUserId(input: {
		sessionId: string;
	}): Promise<string | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({ userId: sessions.userId })
			.from(sessions)
			.where(eq(sessions.id, input.sessionId))
			.limit(1);
		return row?.userId ?? null;
	}

  async reserveSessionRuntimeProvisioning(
    input: ReserveSessionRuntimeProvisioningInput,
  ): Promise<RuntimeProvisioningLease | null> {
		const database = requireDb(this.database);
    // The lease timestamp is also its immutable generation token. Advance it
    // beyond updated_at (and any stale active token) so rapid release/reserve
    // cycles and a wall-clock rollback cannot recreate an older generation.
    const startedAt = sql<Date>`GREATEST(
      date_trunc('milliseconds', clock_timestamp()),
      date_trunc('milliseconds', ${sessions.updatedAt}) + interval '1 millisecond',
      date_trunc('milliseconds', ${sessions.runtimeProvisioningStartedAt}) + interval '1 millisecond'
    )`;
    const reserved = await database
      .update(sessions)
      .set({
        runtimeProvisioningStartedAt: startedAt,
        runtimeProvisioningAppId: null,
        runtimeProvisioningInstanceId: null,
        runtimeProvisioningSandboxName: null,
        runtimeProvisioningHostOwned: null,
        runtimeProvisioningHostLaunchSpec: null,
        updatedAt: startedAt,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          ne(sessions.status, "terminated"),
          isNull(sessions.completedAt),
          isNull(sessions.stopRequestedAt),
          isNull(sessions.daprInstanceId),
          or(
            isNull(sessions.runtimeProvisioningStartedAt),
            and(
              sql`${sessions.runtimeProvisioningStartedAt} < clock_timestamp() - interval '10 minutes'`,
              isNull(sessions.runtimeProvisioningAppId),
              isNull(sessions.runtimeProvisioningInstanceId),
              isNull(sessions.runtimeProvisioningSandboxName),
              isNull(sessions.runtimeProvisioningHostOwned),
              isNull(sessions.runtimeProvisioningHostLaunchSpec),
            ),
          ),
          activeProvisioningParentWorkflow(),
          activeProvisioningParentSession(),
        ),
      )
      .returning({ startedAt: sessions.runtimeProvisioningStartedAt });
    const lease = reserved[0]?.startedAt;
    return lease ? { startedAt: lease } : null;
  }

  async stageSessionRuntimeProvisioning(
    input: StageSessionRuntimeProvisioningInput,
  ): Promise<boolean> {
    const runtimeAppId = input.runtimeAppId.trim();
    const durableInstanceId = input.durableInstanceId.trim();
    const runtimeSandboxName = input.runtimeSandboxName?.trim() || null;
    if (!runtimeAppId || !durableInstanceId) return false;
    const emptyStagedTarget = and(
      isNull(sessions.runtimeProvisioningAppId),
      isNull(sessions.runtimeProvisioningInstanceId),
      isNull(sessions.runtimeProvisioningSandboxName),
      isNull(sessions.runtimeProvisioningHostOwned),
      isNull(sessions.runtimeProvisioningHostLaunchSpec),
    );
    const exactStagedTarget = and(
      eq(sessions.runtimeProvisioningAppId, runtimeAppId),
      eq(sessions.runtimeProvisioningInstanceId, durableInstanceId),
      runtimeSandboxName == null
        ? isNull(sessions.runtimeProvisioningSandboxName)
        : eq(sessions.runtimeProvisioningSandboxName, runtimeSandboxName),
      eq(sessions.runtimeProvisioningHostOwned, input.runtimeHostOwned),
      input.runtimeHostLaunchSpec == null
        ? isNull(sessions.runtimeProvisioningHostLaunchSpec)
        : sql`${sessions.runtimeProvisioningHostLaunchSpec} = ${JSON.stringify(input.runtimeHostLaunchSpec)}::jsonb`,
    );

    const database = requireDb(this.database);
    const staged = await database
      .update(sessions)
      .set({
        runtimeProvisioningAppId: runtimeAppId,
        runtimeProvisioningInstanceId: durableInstanceId,
        runtimeProvisioningSandboxName: runtimeSandboxName,
        runtimeProvisioningHostOwned: input.runtimeHostOwned,
        runtimeProvisioningHostLaunchSpec: input.runtimeHostLaunchSpec,
        updatedAt: sql<Date>`GREATEST(
          date_trunc('milliseconds', clock_timestamp()),
          ${sessions.updatedAt},
          ${toPostgresTimestampParam(input.expectedStartedAt)}
        )`,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
          ne(sessions.status, "terminated"),
          isNull(sessions.completedAt),
          isNull(sessions.stopRequestedAt),
          activeProvisioningParentWorkflow(),
          activeProvisioningParentSession(),
          or(emptyStagedTarget, exactStagedTarget),
        ),
      )
      .returning({ id: sessions.id });
    return staged.length > 0;
  }

  async listStaleSessionRuntimeProvisioningTargets(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<StaleSessionRuntimeProvisioningTarget[]> {
    const database = requireDb(this.database);
    const rows = await database
      .select({
        sessionId: sessions.id,
        startedAt: sessions.runtimeProvisioningStartedAt,
        runtimeAppId: sessions.runtimeProvisioningAppId,
        durableInstanceId: sessions.runtimeProvisioningInstanceId,
        runtimeSandboxName: sessions.runtimeProvisioningSandboxName,
        runtimeHostOwned: sessions.runtimeProvisioningHostOwned,
        runtimeHostLaunchSpec: sessions.runtimeProvisioningHostLaunchSpec,
        publishedDaprInstanceId: sessions.daprInstanceId,
        publishedRuntimeAppId: sessions.runtimeAppId,
        publishedRuntimeSandboxName: sessions.runtimeSandboxName,
      })
      .from(sessions)
      .where(
        and(
          inArray(sessions.status, ["rescheduling", "running", "idle"]),
          isNull(sessions.stopRequestedAt),
          isNull(sessions.completedAt),
          isNotNull(sessions.runtimeProvisioningStartedAt),
          isNotNull(sessions.runtimeProvisioningAppId),
          isNotNull(sessions.runtimeProvisioningInstanceId),
          isNotNull(sessions.runtimeProvisioningHostOwned),
          sql`${sessions.runtimeProvisioningStartedAt} <= ${toPostgresTimestampParam(input.staleBefore)}`,
          sql`(
							${sessions.workflowExecutionId} IS NULL
							OR EXISTS (
              SELECT 1
              FROM ${workflowExecutions}
              WHERE ${workflowExecutions.id} = ${sessions.workflowExecutionId}
                AND ${workflowExecutions.status} IN ('pending', 'running')
                AND ${workflowExecutions.stopRequestedAt} IS NULL
                AND ${workflowExecutions.completedAt} IS NULL
            )
          )`,
          activeProvisioningParentSession(),
        ),
      )
      .orderBy(asc(sessions.runtimeProvisioningStartedAt))
      .limit(Math.max(1, Math.min(Math.trunc(input.limit || 20), 200)));

    return rows.flatMap((row) => {
      const startedAt = row.startedAt;
      const runtimeAppId = row.runtimeAppId?.trim() ?? "";
      const durableInstanceId = row.durableInstanceId?.trim() ?? "";
      if (
        !startedAt ||
        !runtimeAppId ||
        !durableInstanceId ||
        row.runtimeHostOwned == null
      ) {
        return [];
      }
      return [
        {
          sessionId: row.sessionId,
          startedAt,
          runtimeAppId,
          durableInstanceId,
          runtimeSandboxName: row.runtimeSandboxName?.trim() || null,
          runtimeHostOwned: row.runtimeHostOwned,
          runtimeHostLaunchSpec: row.runtimeHostLaunchSpec ?? null,
          publishedGeneration:
            row.publishedDaprInstanceId === durableInstanceId &&
            row.publishedRuntimeAppId === runtimeAppId &&
            (row.publishedRuntimeSandboxName?.trim() || null) ===
              (row.runtimeSandboxName?.trim() || null),
        },
      ];
    });
  }

  async attachStagedSessionRuntimeProvisioning(input: {
    sessionId: string;
    expectedStartedAt: Date;
  }): Promise<boolean> {
    const database = requireDb(this.database);
    const attached = await database
      .update(sessions)
      .set({
        daprInstanceId: sql<string>`${sessions.runtimeProvisioningInstanceId}`,
        natsSubject: `session.events.${input.sessionId}`,
        runtimeAppId: sql<string>`${sessions.runtimeProvisioningAppId}`,
        runtimeSandboxName: sql<
          string | null
        >`${sessions.runtimeProvisioningSandboxName}`,
        runtimeHostOwned: sql<boolean>`${sessions.runtimeProvisioningHostOwned}`,
        runtimeHostLaunchSpec: sql<Record<
          string,
          unknown
        > | null>`${sessions.runtimeProvisioningHostLaunchSpec}`,
        updatedAt: sql<Date>`GREATEST(
          date_trunc('milliseconds', clock_timestamp()),
          ${sessions.updatedAt},
          ${toPostgresTimestampParam(input.expectedStartedAt)}
        )`,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
          isNotNull(sessions.runtimeProvisioningAppId),
          isNotNull(sessions.runtimeProvisioningInstanceId),
          isNotNull(sessions.runtimeProvisioningHostOwned),
          inArray(sessions.status, ["rescheduling", "running", "idle"]),
          isNull(sessions.completedAt),
          isNull(sessions.stopRequestedAt),
          sql`(
            ${sessions.workflowExecutionId} IS NULL
            OR EXISTS (
              SELECT 1
              FROM ${workflowExecutions}
              WHERE ${workflowExecutions.id} = ${sessions.workflowExecutionId}
                AND ${workflowExecutions.status} IN ('pending', 'running')
                AND ${workflowExecutions.stopRequestedAt} IS NULL
                AND ${workflowExecutions.completedAt} IS NULL
            )
          )`,
          activeProvisioningParentSession(),
        ),
      )
      .returning({ id: sessions.id });
    return attached.length > 0;
  }

  async completeStagedSessionRuntimeProvisioning(input: {
    sessionId: string;
    expectedStartedAt: Date;
    runtimeAppId: string;
  }): Promise<CompleteSessionRuntimeHostRecoveryResult> {
    return this.completeSessionRuntimeHostRecovery({
      sessionId: input.sessionId,
      expectedRuntimeAppId: input.runtimeAppId,
      expectedStartedAt: input.expectedStartedAt,
    });
  }

  async inspectSessionRuntimeHostRecovery(input: {
    sessionId: string;
    expectedRuntimeAppId: string;
  }): Promise<SessionRuntimeHostRecoveryRecord | null> {
    const database = requireDb(this.database);
    const [row] = await database
      .select({
        runtimeInstanceId: sessions.daprInstanceId,
        runtimeAppId: sessions.runtimeAppId,
        runtimeSandboxName: sessions.runtimeSandboxName,
        launchSpec: sessions.runtimeHostLaunchSpec,
        recoveryStartedAt: sessions.runtimeProvisioningStartedAt,
        recoveryAppId: sessions.runtimeProvisioningAppId,
        recoveryInstanceId: sessions.runtimeProvisioningInstanceId,
        recoverySandboxName: sessions.runtimeProvisioningSandboxName,
        recoveryHostOwned: sessions.runtimeProvisioningHostOwned,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.runtimeAppId, input.expectedRuntimeAppId),
          eq(sessions.runtimeHostOwned, true),
          ne(sessions.status, "terminated"),
          isNull(sessions.completedAt),
          isNull(sessions.stopRequestedAt),
          sql`(
						${sessions.workflowExecutionId} IS NULL
						OR EXISTS (
							SELECT 1
							FROM ${workflowExecutions}
							WHERE ${workflowExecutions.id} = ${sessions.workflowExecutionId}
							  AND ${workflowExecutions.status} IN ('pending', 'running')
							  AND ${workflowExecutions.stopRequestedAt} IS NULL
								  AND ${workflowExecutions.completedAt} IS NULL
							)
						)`,
          activeProvisioningParentSession(),
        ),
      )
      .limit(1);
    const runtimeAppId = row?.runtimeAppId?.trim() ?? "";
    const runtimeSandboxName = row?.runtimeSandboxName?.trim() ?? "";
    if (!runtimeAppId || !runtimeSandboxName) return null;
    const recoveryStartedAt =
      row?.recoveryStartedAt &&
      row.recoveryAppId?.trim() === runtimeAppId &&
      row.recoveryInstanceId?.trim() === row.runtimeInstanceId?.trim() &&
      row.recoverySandboxName?.trim() === runtimeSandboxName &&
      row.recoveryHostOwned === true
        ? row.recoveryStartedAt
        : null;
    return {
      runtimeAppId,
      runtimeSandboxName,
      launchSpec: row?.launchSpec ?? null,
      recoveryStartedAt,
    };
  }

  async beginSessionRuntimeHostRecovery(input: {
    sessionId: string;
    expectedRuntimeAppId: string;
  }): Promise<SessionRuntimeHostRecoveryLease | null> {
    const database = requireDb(this.database);
    return database.transaction(async (tx) => {
      const [row] = await tx
        .select({
          runtimeInstanceId: sessions.daprInstanceId,
          runtimeAppId: sessions.runtimeAppId,
          runtimeSandboxName: sessions.runtimeSandboxName,
          launchSpec: sessions.runtimeHostLaunchSpec,
          startedAt: sessions.runtimeProvisioningStartedAt,
          stagedAppId: sessions.runtimeProvisioningAppId,
          stagedInstanceId: sessions.runtimeProvisioningInstanceId,
          stagedSandboxName: sessions.runtimeProvisioningSandboxName,
          stagedHostOwned: sessions.runtimeProvisioningHostOwned,
          updatedAt: sessions.updatedAt,
          workflowExecutionId: sessions.workflowExecutionId,
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.id, input.sessionId),
            eq(sessions.runtimeAppId, input.expectedRuntimeAppId),
            eq(sessions.runtimeHostOwned, true),
            isNotNull(sessions.runtimeHostLaunchSpec),
            ne(sessions.status, "terminated"),
            isNull(sessions.completedAt),
            isNull(sessions.stopRequestedAt),
            activeProvisioningParentSession(),
          ),
        )
        .for("update")
        .limit(1);
      if (!row) return null;
      if (row.workflowExecutionId) {
        const [parent] = await tx
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.id, row.workflowExecutionId),
              inArray(workflowExecutions.status, ["pending", "running"]),
              isNull(workflowExecutions.stopRequestedAt),
              isNull(workflowExecutions.completedAt),
            ),
          )
          .limit(1);
        if (!parent) return null;
      }

      const runtimeInstanceId = row.runtimeInstanceId?.trim() ?? "";
      const runtimeAppId = row.runtimeAppId?.trim() ?? "";
      const runtimeSandboxName = row.runtimeSandboxName?.trim() ?? "";
      if (
        !runtimeInstanceId ||
        !runtimeAppId ||
        !runtimeSandboxName ||
        !row.launchSpec
      ) {
        return null;
      }

      const ownsExactRecovery =
        row.startedAt != null &&
        row.stagedAppId?.trim() === runtimeAppId &&
        row.stagedInstanceId?.trim() === runtimeInstanceId &&
        row.stagedSandboxName?.trim() === runtimeSandboxName &&
        row.stagedHostOwned === true;
      if (row.startedAt && !ownsExactRecovery) return null;

      let startedAt = ownsExactRecovery ? row.startedAt : null;
      if (!startedAt) {
        const [reserved] = await tx
          .update(sessions)
          .set({
            runtimeProvisioningStartedAt: sql<Date>`GREATEST(
							date_trunc('milliseconds', clock_timestamp()),
							date_trunc('milliseconds', ${sessions.updatedAt}) + interval '1 millisecond'
						)`,
            runtimeProvisioningAppId: runtimeAppId,
            runtimeProvisioningInstanceId: runtimeInstanceId,
            runtimeProvisioningSandboxName: runtimeSandboxName,
            runtimeProvisioningHostOwned: true,
            runtimeProvisioningHostLaunchSpec: row.launchSpec,
            updatedAt: sql<Date>`GREATEST(
							date_trunc('milliseconds', clock_timestamp()),
							date_trunc('milliseconds', ${sessions.updatedAt}) + interval '1 millisecond'
						)`,
          })
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(sessions.runtimeAppId, input.expectedRuntimeAppId),
              isNull(sessions.runtimeProvisioningStartedAt),
              activeProvisioningParentSession(),
            ),
          )
          .returning({ startedAt: sessions.runtimeProvisioningStartedAt });
        startedAt = reserved?.startedAt ?? null;
      }
      if (!startedAt) return null;
      return {
        startedAt,
        runtimeAppId,
        runtimeSandboxName,
        launchSpec: row.launchSpec,
      };
    });
  }

  async completeSessionRuntimeHostRecovery(input: {
    sessionId: string;
    expectedRuntimeAppId: string;
    expectedStartedAt: Date;
  }): Promise<CompleteSessionRuntimeHostRecoveryResult> {
    const database = requireDb(this.database);
    return database.transaction(async (tx) => {
      const [row] = await tx
        .select({
          status: sessions.status,
          stopRequestedAt: sessions.stopRequestedAt,
          completedAt: sessions.completedAt,
          runtimeAppId: sessions.runtimeAppId,
          startedAt: sessions.runtimeProvisioningStartedAt,
          workflowExecutionId: sessions.workflowExecutionId,
          parentExecutionId: sessions.parentExecutionId,
        })
        .from(sessions)
        .where(eq(sessions.id, input.sessionId))
        .for("update")
        .limit(1);
      if (
        !row ||
        row.runtimeAppId?.trim() !== input.expectedRuntimeAppId.trim()
      ) {
        return "superseded";
      }
      if (
        row.status === "terminated" ||
        row.stopRequestedAt != null ||
        row.completedAt != null
      ) {
        return "stopped";
      }
      if (row.workflowExecutionId) {
        const [parent] = await tx
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.id, row.workflowExecutionId),
              inArray(workflowExecutions.status, ["pending", "running"]),
              isNull(workflowExecutions.stopRequestedAt),
              isNull(workflowExecutions.completedAt),
            ),
          )
          .limit(1);
        if (!parent) return "stopped";
      }
      if (row.parentExecutionId) {
        const [parent] = await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, row.parentExecutionId),
              inArray(sessions.status, ["rescheduling", "running", "idle"]),
              isNull(sessions.stopRequestedAt),
              isNull(sessions.completedAt),
            ),
          )
          .limit(1);
        if (!parent) return "stopped";
      }
      if (row.startedAt == null) return "already_completed";
      if (row.startedAt.getTime() !== input.expectedStartedAt.getTime()) {
        return "conflict";
      }
      const completed = await tx
        .update(sessions)
        .set({
          runtimeProvisioningStartedAt: null,
          runtimeProvisioningAppId: null,
          runtimeProvisioningInstanceId: null,
          runtimeProvisioningSandboxName: null,
          runtimeProvisioningHostOwned: null,
          runtimeProvisioningHostLaunchSpec: null,
          updatedAt: sql<Date>`GREATEST(
						date_trunc('milliseconds', clock_timestamp()),
						${sessions.updatedAt},
						${toPostgresTimestampParam(input.expectedStartedAt)}
					)`,
        })
        .where(
          and(
            eq(sessions.id, input.sessionId),
            eq(sessions.runtimeAppId, input.expectedRuntimeAppId),
            eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
            isNull(sessions.stopRequestedAt),
            isNull(sessions.completedAt),
            ne(sessions.status, "terminated"),
            activeProvisioningParentWorkflow(),
            activeProvisioningParentSession(),
          ),
        )
        .returning({ id: sessions.id });
      return completed.length > 0 ? "completed" : "conflict";
    });
  }

  async acknowledgeRuntimeProvisioningCompensation(
    input: AcknowledgeRuntimeProvisioningCompensationInput,
  ): Promise<boolean> {
    const database = requireDb(this.database);
    const acknowledged = await database
      .update(sessions)
      .set({
        runtimeProvisioningStartedAt: null,
        runtimeProvisioningAppId: null,
        runtimeProvisioningInstanceId: null,
        runtimeProvisioningSandboxName: null,
        runtimeProvisioningHostOwned: null,
        runtimeProvisioningHostLaunchSpec: null,
        updatedAt: sql<Date>`GREATEST(
          date_trunc('milliseconds', clock_timestamp()),
          ${sessions.updatedAt},
          ${toPostgresTimestampParam(input.expectedStartedAt)}
        )`,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
          runtimeProvisioningCompensationAuthority(),
        ),
      )
      .returning({ id: sessions.id });
    return acknowledged.length > 0;
  }

  async canCompensateRuntimeProvisioning(
    input: AcknowledgeRuntimeProvisioningCompensationInput,
  ): Promise<boolean> {
    const database = requireDb(this.database);
    const [row] = await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
          runtimeProvisioningCompensationAuthority(),
        ),
      )
      .limit(1);
    return row != null;
  }

  async canReleaseRuntimeProvisioning(
    input: AcknowledgeRuntimeProvisioningCompensationInput,
  ): Promise<boolean> {
    const database = requireDb(this.database);
    const [row] = await database
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, input.sessionId),
          isNull(sessions.stopRequestedAt),
          isNull(sessions.completedAt),
          ne(sessions.status, "terminated"),
          eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
          activeProvisioningParentWorkflow(),
          activeProvisioningParentSession(),
        ),
      )
      .limit(1);
    return row != null;
  }

  async claimStaleSessionRuntimeProvisioning(input: {
    current: StaleSessionRuntimeProvisioningTarget;
    claimedAt: Date;
  }): Promise<boolean> {
    const database = requireDb(this.database);
    const { current, claimedAt } = input;
    if (
      current.publishedGeneration ||
      claimedAt.getTime() <= current.startedAt.getTime()
    ) {
      return false;
    }
    const claimed = await database
      .update(sessions)
      .set({
        runtimeProvisioningStartedAt: claimedAt,
        updatedAt: sql<Date>`GREATEST(
					date_trunc('milliseconds', clock_timestamp()),
					${sessions.updatedAt},
					${toPostgresTimestampParam(claimedAt)}
				)`,
      })
      .where(
        and(
          eq(sessions.id, current.sessionId),
          eq(sessions.runtimeProvisioningStartedAt, current.startedAt),
          eq(sessions.runtimeProvisioningAppId, current.runtimeAppId),
          eq(sessions.runtimeProvisioningInstanceId, current.durableInstanceId),
          current.runtimeSandboxName == null
            ? isNull(sessions.runtimeProvisioningSandboxName)
            : eq(
                sessions.runtimeProvisioningSandboxName,
                current.runtimeSandboxName,
              ),
          eq(sessions.runtimeProvisioningHostOwned, current.runtimeHostOwned),
          isNull(sessions.daprInstanceId),
          isNull(sessions.stopRequestedAt),
          isNull(sessions.completedAt),
          ne(sessions.status, "terminated"),
          activeProvisioningParentWorkflow(),
          activeProvisioningParentSession(),
        ),
      )
      .returning({ id: sessions.id });
    return claimed.length > 0;
  }

  async prepareClaimedSessionRuntimeProvisioningRedrive(input: {
    claimed: StaleSessionRuntimeProvisioningTarget;
    replacement: StaleSessionRuntimeProvisioningTarget;
  }): Promise<boolean> {
    const database = requireDb(this.database);
    const { claimed, replacement } = input;
    if (
      replacement.sessionId !== claimed.sessionId ||
      replacement.startedAt.getTime() !== claimed.startedAt.getTime() ||
      claimed.publishedGeneration ||
      replacement.publishedGeneration ||
      !replacement.runtimeAppId.trim() ||
      !replacement.durableInstanceId.trim() ||
      replacement.durableInstanceId === claimed.durableInstanceId ||
      replacement.runtimeHostOwned !== claimed.runtimeHostOwned ||
      (claimed.runtimeHostOwned &&
        (replacement.runtimeAppId === claimed.runtimeAppId ||
          replacement.runtimeSandboxName === claimed.runtimeSandboxName))
    ) {
      return false;
    }
    const prepared = await database
      .update(sessions)
      .set({
        runtimeProvisioningAppId: replacement.runtimeAppId,
        runtimeProvisioningInstanceId: replacement.durableInstanceId,
        runtimeProvisioningSandboxName: replacement.runtimeSandboxName,
        runtimeProvisioningHostOwned: replacement.runtimeHostOwned,
        runtimeProvisioningHostLaunchSpec: replacement.runtimeHostLaunchSpec,
        updatedAt: sql<Date>`GREATEST(
					date_trunc('milliseconds', clock_timestamp()),
					${sessions.updatedAt},
					${toPostgresTimestampParam(claimed.startedAt)}
				)`,
      })
      .where(
        and(
          eq(sessions.id, claimed.sessionId),
          eq(sessions.runtimeProvisioningStartedAt, claimed.startedAt),
          eq(sessions.runtimeProvisioningAppId, claimed.runtimeAppId),
          eq(sessions.runtimeProvisioningInstanceId, claimed.durableInstanceId),
          claimed.runtimeSandboxName == null
            ? isNull(sessions.runtimeProvisioningSandboxName)
            : eq(
                sessions.runtimeProvisioningSandboxName,
                claimed.runtimeSandboxName,
              ),
          eq(sessions.runtimeProvisioningHostOwned, claimed.runtimeHostOwned),
          isNull(sessions.daprInstanceId),
          isNull(sessions.stopRequestedAt),
          isNull(sessions.completedAt),
          ne(sessions.status, "terminated"),
          activeProvisioningParentWorkflow(),
          activeProvisioningParentSession(),
        ),
      )
      .returning({ id: sessions.id });
    return prepared.length > 0;
  }

  async releaseSessionRuntimeProvisioning(
    input: AcknowledgeRuntimeProvisioningCompensationInput,
  ): Promise<boolean> {
    const database = requireDb(this.database);
    const released = await database
      .update(sessions)
      .set({
        runtimeProvisioningStartedAt: null,
        runtimeProvisioningAppId: null,
        runtimeProvisioningInstanceId: null,
        runtimeProvisioningSandboxName: null,
        runtimeProvisioningHostOwned: null,
        runtimeProvisioningHostLaunchSpec: null,
        updatedAt: sql<Date>`GREATEST(
          date_trunc('milliseconds', clock_timestamp()),
          ${sessions.updatedAt},
          ${toPostgresTimestampParam(input.expectedStartedAt)}
        )`,
      })
      .where(
        and(
          eq(sessions.id, input.sessionId),
          isNull(sessions.stopRequestedAt),
          isNull(sessions.completedAt),
          ne(sessions.status, "terminated"),
          eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
          activeProvisioningParentWorkflow(),
          activeProvisioningParentSession(),
        ),
      )
      .returning({ id: sessions.id });
    return released.length > 0;
  }

  async attachSessionRuntime(
    input: AttachSessionRuntimeInput,
  ): Promise<boolean> {
    const database = requireDb(this.database);
    const patch: Omit<Partial<Session>, "updatedAt"> & {
      updatedAt: SQL<Date>;
    } = {
      runtimeProvisioningStartedAt: null,
      runtimeProvisioningAppId: null,
      runtimeProvisioningInstanceId: null,
      runtimeProvisioningSandboxName: null,
      runtimeProvisioningHostOwned: null,
      runtimeProvisioningHostLaunchSpec: null,
      updatedAt: sql<Date>`GREATEST(
        date_trunc('milliseconds', clock_timestamp()),
        ${sessions.updatedAt},
        ${toPostgresTimestampParam(input.expectedStartedAt)}
      )`,
		};
		if (input.daprInstanceId !== undefined) {
			patch.daprInstanceId = input.daprInstanceId;
		}
		if (input.natsSubject !== undefined) {
			patch.natsSubject = input.natsSubject;
		}
		if (input.runtimeAppId !== undefined) {
			patch.runtimeAppId = input.runtimeAppId;
		}
		if (input.runtimeSandboxName !== undefined) {
			patch.runtimeSandboxName = input.runtimeSandboxName;
		}
    if (input.runtimeHostOwned !== undefined) {
      patch.runtimeHostOwned = input.runtimeHostOwned;
    }
    if (input.runtimeHostLaunchSpec !== undefined) {
      patch.runtimeHostLaunchSpec = input.runtimeHostLaunchSpec;
    }
    const attached = await database
			.update(sessions)
			.set(patch)
      .where(
        and(
          eq(sessions.id, input.sessionId),
          eq(sessions.runtimeProvisioningStartedAt, input.expectedStartedAt),
          ne(sessions.status, "terminated"),
          isNull(sessions.completedAt),
          isNull(sessions.stopRequestedAt),
          activeProvisioningParentWorkflow(),
          activeProvisioningParentSession(),
        ),
      )
      .returning({ id: sessions.id });
    return attached.length > 0;
  }

  async authorizeSessionRuntimeStart(
    input: AuthorizeSessionRuntimeStartInput,
  ): Promise<SessionRuntimeStartAuthorizationResult> {
    const database = requireDb(this.database);
    const initialRows = resultRows<{
      id: string;
      user_id: string;
      project_id: string | null;
      workflow_execution_id: string | null;
      parent_execution_id: string | null;
    }>(
      await database.execute(sql`
			SELECT id, user_id, project_id, workflow_execution_id, parent_execution_id
			FROM sessions
			WHERE id = ${input.sessionId}
			LIMIT 1
		`),
    );
    const initial = initialRows[0];
    if (!initial) return { status: "not_found" };
    if (
      initial.user_id !== input.userId ||
      initial.project_id !== input.projectId
    ) {
      return { status: "principal_mismatch" };
    }

    return database.transaction(async (tx) => {
      // Match lifecycle ordering: parent workflow, parent session, child session.
      // A stop that already owns either parent lock wins; authorization then
      // re-evaluates against its committed stop state and is denied.
      if (initial.workflow_execution_id) {
        const parentWorkflow = resultRows<{ id: string }>(
          await tx.execute(sql`
					SELECT id
					FROM workflow_executions
					WHERE id = ${initial.workflow_execution_id}
					  AND status IN ('pending', 'running')
					  AND stop_requested_at IS NULL
					  AND completed_at IS NULL
					FOR UPDATE
				`),
        );
        if (parentWorkflow.length === 0) {
          return { status: "parent_inactive" as const };
        }
      }

      if (initial.parent_execution_id) {
        const parentSession = resultRows<{ id: string }>(
          await tx.execute(sql`
					SELECT id
					FROM sessions
					WHERE id = ${initial.parent_execution_id}
					  AND status IN ('rescheduling', 'running', 'idle')
					  AND stop_requested_at IS NULL
					  AND completed_at IS NULL
					FOR UPDATE
				`),
        );
        if (parentSession.length === 0) {
          return { status: "parent_inactive" as const };
        }
      }

      const currentRows = resultRows<{
        user_id: string;
        project_id: string | null;
        workflow_execution_id: string | null;
        parent_execution_id: string | null;
        status: string;
        stop_requested_at: Date | null;
        completed_at: Date | null;
        runtime_provisioning_started_at: Date | null;
        dapr_instance_id: string | null;
        runtime_app_id: string | null;
      }>(
        await tx.execute(sql`
				SELECT user_id, project_id, workflow_execution_id, parent_execution_id,
				       status, stop_requested_at, completed_at,
				       runtime_provisioning_started_at, dapr_instance_id, runtime_app_id
				FROM sessions
				WHERE id = ${input.sessionId}
				LIMIT 1
				FOR UPDATE
			`),
      );
      const current = currentRows[0];
      if (!current) return { status: "not_found" as const };
      if (
        current.user_id !== input.userId ||
        current.project_id !== input.projectId
      ) {
        return { status: "principal_mismatch" as const };
      }
      if (
        current.workflow_execution_id !== initial.workflow_execution_id ||
        current.parent_execution_id !== initial.parent_execution_id ||
        !(["rescheduling", "running", "idle"] as string[]).includes(
          current.status,
        ) ||
        current.stop_requested_at != null ||
        current.completed_at != null
      ) {
        return { status: "inactive" as const };
      }

      if (input.teamRole === "member") {
        if (!input.teamId) return { status: "team_inactive" as const };
        const memberships = resultRows<{ status: string }>(
          await tx.execute(sql`
					SELECT member.status
					FROM team_members AS member
					JOIN teams AS team ON team.id = member.team_id
					WHERE member.session_id = ${input.sessionId}
					  AND member.team_id = ${input.teamId}
					  AND member.role = 'member'
					  AND team.status = 'active'
					  AND team.lead_session_id IS NOT DISTINCT FROM ${initial.parent_execution_id}
					  AND team.workflow_execution_id IS NOT DISTINCT FROM ${initial.workflow_execution_id}
					FOR UPDATE OF member
				`),
        );
        const membership = memberships[0];
        if (!membership) return { status: "team_inactive" as const };
        if (membership.status === "starting") {
          return { status: "team_pending" as const };
        }
        if (membership.status !== "working") {
          return { status: "team_inactive" as const };
        }
      }

      if (!current.runtime_app_id?.trim()) {
        return { status: "runtime_unpublished" as const };
      }
      if (current.runtime_app_id.trim() !== input.runtimeAppId.trim()) {
        return { status: "runtime_superseded" as const };
      }
      if (
        current.runtime_provisioning_started_at != null ||
        !current.dapr_instance_id?.trim()
      ) {
        return { status: "runtime_unpublished" as const };
      }
      if (current.dapr_instance_id.trim() !== input.runtimeInstanceId.trim()) {
        return { status: "runtime_superseded" as const };
      }
      return { status: "authorized" as const };
    });
	}

	async getSessionRuntimeTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionRuntimeTarget | null> {
		const database = requireDb(this.database);
		const conditions = [eq(sessions.id, input.sessionId)];
		if (input.projectId) {
			const projectCondition = or(
				eq(sessions.projectId, input.projectId),
				eq(agents.projectId, input.projectId),
			);
			if (projectCondition) conditions.push(projectCondition);
		}
		const [row] = await database
			.select({
				runtimeAppId: sessions.runtimeAppId,
				runtimeSandboxName: sessions.runtimeSandboxName,
				agentSlug: agents.slug,
				agentRuntimeAppId: agents.runtimeAppId,
			})
			.from(sessions)
			.leftJoin(agents, eq(agents.id, sessions.agentId))
			.where(and(...conditions))
			.limit(1);
		if (!row) return null;

		const persistedAppId = row.runtimeAppId?.trim();
		if (persistedAppId) {
			return {
				appId: persistedAppId,
				invokeTarget: agentRuntimeInvokeTarget(persistedAppId),
				runtimeSandboxName: row.runtimeSandboxName ?? null,
				source: "persisted",
			};
		}

		if (row.agentSlug) {
			const appId =
				row.agentRuntimeAppId?.trim() ||
				agentRuntimeDedicatedAppId(row.agentSlug);
			return {
				appId,
				invokeTarget: agentRuntimeInvokeTarget(appId),
				runtimeSandboxName: null,
				source: "agent",
			};
		}

		return {
			appId: DEFAULT_RUNTIME_ID,
			invokeTarget: agentRuntimeInvokeTarget(DEFAULT_RUNTIME_ID),
			runtimeSandboxName: null,
			source: "legacy",
		};
	}

	async getSessionRuntimeDebugTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionRuntimeDebugTarget | null> {
		const database = requireDb(this.database);
		const conditions = [eq(sessions.id, input.sessionId)];
		if (input.projectId) conditions.push(eq(agents.projectId, input.projectId));
		const [row] = await database
			.select({
				runtimeAppId: sessions.runtimeAppId,
				runtimeSandboxName: sessions.runtimeSandboxName,
				agentSlug: agents.slug,
				agentRuntime: agents.runtime,
				agentRuntimeAppId: agents.runtimeAppId,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.where(and(...conditions))
			.limit(1);
		if (!row) return null;
		const appId =
			row.runtimeAppId?.trim() ||
			row.agentRuntimeAppId?.trim() ||
			agentRuntimeDedicatedAppId(row.agentSlug);
		return {
			appId,
			invokeTarget: agentRuntimeInvokeTarget(appId),
			runtimeSandboxName: row.runtimeSandboxName ?? null,
			source: row.runtimeAppId?.trim() ? "persisted" : "agent",
			agentSlug: row.agentSlug,
			agentRuntime: row.agentRuntime ?? null,
		};
	}

	async getBrowserSessionTarget(input: {
		sessionId: string;
		projectId?: string | null;
	}): Promise<SessionBrowserTarget | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({
				sessionId: sessions.id,
				agentSlug: agents.slug,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.where(
				and(
					eq(sessions.id, input.sessionId),
					input.projectId ? eq(agents.projectId, input.projectId) : undefined,
				),
			)
			.limit(1);
		return row ?? null;
	}

	async listCliWorkspaceSessionCandidates(input: {
		executionId: string;
		limit: number;
	}): Promise<CliWorkspaceSessionCandidateRecord[]> {
		const executionId = input.executionId.trim();
		if (!executionId) return [];
		const limit = Math.max(1, Math.min(Math.trunc(input.limit || 8), 50));
		const database = requireDb(this.database);
		return database
			.select({
				id: sessions.id,
				userId: sessions.userId,
				projectId: sessions.projectId,
				runtimeAppId: sessions.runtimeAppId,
				runtimeSandboxName: sessions.runtimeSandboxName,
				agentSlug: agents.slug,
				agentRuntime: agents.runtime,
				agentRuntimeAppId: agents.runtimeAppId,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.where(
				and(
					eq(sessions.workflowExecutionId, executionId),
					isNotNull(sessions.runtimeAppId),
				),
			)
			.orderBy(desc(sessions.createdAt))
			.limit(limit);
	}

	async listLivenessReconcileCandidates(input: {
		minAgeSeconds: number;
		limit: number;
	}): Promise<LivenessReconcileCandidateRecord[]> {
		const database = requireDb(this.database);
		const minAge = Math.max(0, Math.trunc(input.minAgeSeconds || 0));
		const limit = Math.max(1, Math.min(Math.trunc(input.limit || 10), 200));
		// A benchmark/eval INSTANCE is coordinator-owned (single stop authority) —
		// flag it here so the pure decider can skip it without a second round-trip.
		// The candidate keys MUST match the canonical getSessionCoordinatorOwner
		// (adapters/lifecycle-ownership.ts): the session's workflow_execution_id,
		// dapr_instance_id, AND its raw id. Per-column IN lists (rather than an
		// 8-way OR) keep it index-friendly.
		const ownerCandidates = sql`(${sessions.workflowExecutionId}, ${sessions.daprInstanceId}, ${sessions.id})`;
		const coordinatorOwned = sql<boolean>`(
			EXISTS (
				SELECT 1 FROM ${benchmarkRunInstances}
				WHERE ${benchmarkRunInstances.workflowExecutionId} IN ${ownerCandidates}
					OR ${benchmarkRunInstances.daprInstanceId} IN ${ownerCandidates}
			)
			OR EXISTS (
				SELECT 1 FROM ${evaluationRunItems}
				WHERE ${evaluationRunItems.workflowExecutionId} IN ${ownerCandidates}
					OR ${evaluationRunItems.daprInstanceId} IN ${ownerCandidates}
			)
		)`;
		const rows = await database
			.select({
				id: sessions.id,
				status: sessions.status,
				agentId: sessions.agentId,
				agentVersion: sessions.agentVersion,
				agentSlug: agents.slug,
				agentRuntime: agents.runtime,
				userId: sessions.userId,
				projectId: sessions.projectId,
				title: sessions.title,
				resumedFromSessionId: sessions.resumedFromSessionId,
				runtimeAppId: sessions.runtimeAppId,
				daprInstanceId: sessions.daprInstanceId,
				runtimeSandboxName: sessions.runtimeSandboxName,
				pauseRequestedAt: sessions.pauseRequestedAt,
				stopRequestedAt: sessions.stopRequestedAt,
        stopRequestedMode: sessions.stopRequestedMode,
				updatedAt: sessions.updatedAt,
				lastEventAt: sessions.lastEventAt,
				coordinatorOwned,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.where(
        or(
          // Pending stop intents bypass the age, status, and archive gates.
          // Successful lifecycle finalization clears the intent as its durable
          // acknowledgement; therefore terminal cleanup requests are retried after
          // a process crash without making acknowledged rows permanent candidates.
          isNotNull(sessions.stopRequestedAt),
          and(
            isNull(sessions.archivedAt),
				and(
					// `failed` is a NON-terminal ingest state (turn StopFailure leaves no
              // completedAt) — the reconciler is its only finalizer.
					inArray(sessions.status, [
						"running",
						"idle",
						"rescheduling",
						"paused",
						"failed",
					]),
					isNull(sessions.completedAt),
					sql`${sessions.updatedAt} < now() - make_interval(secs => ${minAge})`,
				),
          ),
        ),
      )
      .orderBy(
        asc(
          sql`CASE WHEN ${sessions.stopRequestedAt} IS NOT NULL THEN 0 ELSE 1 END`,
        ),
        asc(sql`COALESCE(${sessions.stopRequestedAt}, ${sessions.updatedAt})`),
			)
			.limit(limit);
		return rows.map((row) => ({
			...row,
			coordinatorOwned: Boolean(row.coordinatorOwned),
		}));
	}

	async listWorkflowExecutionSessionRuntimes(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowExecutionSessionRuntimeRecord[]> {
		const workflowExecutionId = input.workflowExecutionId.trim();
		if (!workflowExecutionId) return [];
		const database = requireDb(this.database);
		const rows = await database
			.select({
				sessionId: sessions.id,
				agentRuntime: agents.runtime,
			})
			.from(sessions)
			.innerJoin(agents, eq(agents.id, sessions.agentId))
			.where(eq(sessions.workflowExecutionId, workflowExecutionId));
		return rows.map((row) => ({
			sessionId: row.sessionId,
			agentRuntime: row.agentRuntime ?? null,
		}));
	}

	async listSandboxSessionOwners(input: {
		sandboxNames: string[];
	}): Promise<SandboxSessionOwnerRecord[]> {
    const names = [
      ...new Set(input.sandboxNames.map((name) => name.trim()).filter(Boolean)),
    ];
		if (names.length === 0) return [];
		const database = requireDb(this.database);
		const rows = await database
			.select({
				id: sessions.id,
				title: sessions.title,
				status: sessions.status,
				workspaceSandboxName: sessions.workspaceSandboxName,
				sandboxName: sessions.sandboxName,
				workspaceSlug: projects.externalId,
			})
			.from(sessions)
			.leftJoin(projects, eq(projects.id, sessions.projectId))
			.where(
				or(
					inArray(sessions.workspaceSandboxName, names),
					inArray(sessions.sandboxName, names),
				),
			)
			.orderBy(asc(sessions.updatedAt));

		const owners = new Map<string, SandboxSessionOwnerRecord>();
		for (const row of rows) {
			const record = {
				id: row.id,
				title: row.title ?? null,
				status: row.status,
				workspaceSlug: row.workspaceSlug ?? "default",
			};
			if (row.workspaceSandboxName) {
				owners.set(row.workspaceSandboxName, {
					...record,
					sandboxName: row.workspaceSandboxName,
				});
			}
			if (row.sandboxName) {
				owners.set(row.sandboxName, {
					...record,
					sandboxName: row.sandboxName,
				});
			}
		}
		return [...owners.values()];
	}

	async getWorkflowEnsureSession(
		sessionId: string,
	): Promise<WorkflowEnsureSessionRecord | null> {
    const database = requireDb(this.database);
    const [session] = await database
      .select({
        id: sessions.id,
        agentId: sessions.agentId,
        agentVersion: sessions.agentVersion,
        userId: sessions.userId,
        projectId: sessions.projectId,
        vaultIds: sessions.vaultIds,
        workflowExecutionId: sessions.workflowExecutionId,
        parentExecutionId: sessions.parentExecutionId,
        sandboxName: sessions.sandboxName,
        runtimeAppId: sessions.runtimeAppId,
        runtimeSandboxName: sessions.runtimeSandboxName,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return session ?? null;
	}

  async createWorkflowEnsureSession(
    input: CreateWorkflowEnsureSessionInput,
  ): Promise<RuntimeProvisioningLease | null> {
		const database = requireDb(this.database);
    return database.transaction(async (tx) => {
      const startedAt = new Date();
      if (input.workflowExecutionId) {
        // Serialize child creation with lifecycle markStopRequested, which locks
        // this same execution row before stamping every existing child. Whichever
        // transaction wins, a session can never be inserted behind a parent stop.
        const activeParent = await tx
          .select({ id: workflowExecutions.id })
          .from(workflowExecutions)
          .where(
            and(
              eq(workflowExecutions.id, input.workflowExecutionId),
              inArray(workflowExecutions.status, ["pending", "running"]),
              isNull(workflowExecutions.stopRequestedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (activeParent.length === 0) return null;
      }

      await tx.insert(sessions).values({
			id: input.id,
			title: input.title,
			status: "rescheduling",
			agentId: input.agentId,
			agentVersion: input.agentVersion,
			environmentId: null,
			environmentVersion: null,
			vaultIds: input.vaultIds,
			userId: input.userId,
			projectId: input.projectId,
			sandboxName: input.sandboxName,
			workflowExecutionId: input.workflowExecutionId,
			parentExecutionId: input.parentExecutionId,
			mlflowSessionId: input.id,
			daprInstanceId: input.id,
        // The parent-row lock and lease are committed together, so lifecycle
        // either observes this child before stopping the parent or prevents
        // the insert. The prospective target is derived from the id while the
        // actual runtime fields remain authoritative.
        runtimeProvisioningStartedAt: startedAt,
      });
      return { startedAt };
		});
	}

	async updateWorkflowEnsureSessionRuntime(
		input: UpdateWorkflowEnsureSessionRuntimeInput,
  ): Promise<boolean> {
    return this.attachSessionRuntime({
      sessionId: input.sessionId,
      expectedStartedAt: input.expectedStartedAt,
				runtimeAppId: input.runtimeAppId,
				runtimeSandboxName: input.runtimeSandboxName,
      runtimeHostOwned: input.runtimeHostOwned,
      runtimeHostLaunchSpec: input.runtimeHostLaunchSpec,
    });
	}

	async listReapableWorkflowSessionRuntimeHosts(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowSessionRuntimeHostRecord[]> {
		const database = requireDb(this.database);
		// `sessions.status` is a user-facing lifecycle marker, not proof that the
		// parent workflow has consumed the child workflow result. Dynamic-script
		// runs make that parent boundary explicit in workflow_script_calls: only
		// reap a session host once its journal row is terminal. Non-script workflow
		// sessions have no journal row and keep the legacy terminal-session behavior.
		const rows = await database
			.select({ id: sessions.id, runtimeAppId: sessions.runtimeAppId })
			.from(sessions)
			.leftJoin(
				workflowScriptCalls,
				eq(workflowScriptCalls.sessionId, sessions.id),
			)
			.where(
				and(
					eq(sessions.workflowExecutionId, input.workflowExecutionId),
					inArray(sessions.status, ["terminated", "failed"]),
          eq(sessions.runtimeHostOwned, true),
					isNotNull(sessions.runtimeAppId),
					or(
						isNull(workflowScriptCalls.callId),
						inArray(workflowScriptCalls.status, [
							"done",
							"null",
							"error",
							"skipped",
						]),
					),
				),
			);
		return rows.flatMap((row) =>
			row.runtimeAppId
				? [{ sessionId: row.id, runtimeAppId: row.runtimeAppId }]
			: [],
		);
	}

  async createSessionFork(
    input: CreateSessionForkInput,
  ): Promise<{ id: string }> {
		const session = await this.createSession({
			agentId: input.agentId,
			agentVersion: input.agentVersion ?? undefined,
			environmentId: input.environmentId ?? undefined,
			environmentVersion: input.environmentVersion ?? undefined,
			vaultIds: input.vaultIds,
			title: input.title,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		return { id: session.id };
	}

	async getPeerSession(sessionId: string): Promise<PeerSessionRecord | null> {
    const database = requireDb(this.database);
    const [session] = await database
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
		return session ? toPeerSessionRecord(session) : null;
	}

  async createPeerSession(
    input: CreatePeerSessionInput,
  ): Promise<CreatePeerSessionResult> {
    const database = requireDb(this.database);
    const resolvedAgent = await this.resolveAgent({
      id: input.agentId,
      version: input.agentVersion ?? undefined,
    });
    if (!resolvedAgent) throw new Error(`Agent ${input.agentId} not found`);
    if (
      input.agentVersion != null &&
      resolvedAgent.version !== input.agentVersion
    ) {
      throw new Error(
        `Agent ${input.agentId} resolved version ${resolvedAgent.version}, expected ${input.agentVersion}`,
      );
    }

    return database.transaction(async (tx) => {
      // Locks serialize this insert with session/workflow stop UPDATEs. If
      // creation wins, the subsequent stop sees the linked child; if stop wins,
      // no child row is created and no external provisioning may begin.
      if (input.workflowExecutionId) {
        const activeExecution = resultRows<{ id: string }>(
          await tx.execute(sql`
					SELECT id
					FROM workflow_executions
					WHERE id = ${input.workflowExecutionId}
					  AND stop_requested_at IS NULL
					  AND completed_at IS NULL
					FOR UPDATE
				`),
        );
        if (activeExecution.length === 0) {
          return { status: "execution_not_active" as const };
        }
      }
      if (input.parentExecutionId) {
        const activeParent = resultRows<{ id: string }>(
          await tx.execute(sql`
					SELECT id
					FROM sessions
					WHERE id = ${input.parentExecutionId}
					  AND stop_requested_at IS NULL
					  AND completed_at IS NULL
					  AND status <> 'terminated'
					FOR UPDATE
				`),
        );
        if (activeParent.length === 0) {
          return { status: "execution_not_active" as const };
        }
      }

      const [inserted] = await tx
        .insert(sessions)
        .values({
			id: input.id,
			title: input.title,
          status: "rescheduling",
          agentId: resolvedAgent.id,
          agentVersion: resolvedAgent.version,
          environmentId: resolvedAgent.environmentId ?? null,
          environmentVersion: resolvedAgent.environmentVersion ?? null,
          vaultIds: resolvedAgent.defaultVaultIds,
			userId: input.userId,
			projectId: input.projectId,
          sandboxName: DEFAULT_SANDBOX_NAME,
          workflowExecutionId: input.workflowExecutionId,
			parentExecutionId: input.parentExecutionId,
          mlflowSessionId: input.id,
        })
        .onConflictDoNothing({ target: sessions.id })
        .returning();
      if (inserted) {
        return {
          status: "ok" as const,
          session: toPeerSessionRecord(inserted),
          created: true,
        };
      }

      const [existing] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, input.id))
        .limit(1);
      if (!existing) {
        throw new Error(
          `Peer session ${input.id} conflicted but could not be loaded`,
        );
      }
      return {
        status: "ok" as const,
        session: toPeerSessionRecord(existing),
        created: false,
      };
		});
	}

  async findSessionIdByDaprInstanceId(
    instanceId: string,
  ): Promise<string | null> {
		const value = instanceId.trim();
		if (!value) return null;
		const database = requireDb(this.database);
		const [row] = await database
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.daprInstanceId, value))
			.limit(1);
		return row?.id ?? null;
	}

	async resolveSessionIdForProvisioningEvent(input: {
		runtimeAppId?: string | null;
		sessionId?: string | null;
	}): Promise<string | null> {
		const runtimeAppId = input.runtimeAppId?.trim() ?? "";
		const sessionId = input.sessionId?.trim() ?? "";
		const matchers = [];
		if (runtimeAppId) matchers.push(eq(sessions.runtimeAppId, runtimeAppId));
		if (sessionId) {
      matchers.push(
        eq(sessions.id, sessionId),
        eq(sessions.daprInstanceId, sessionId),
      );
		}
		if (matchers.length === 0) return null;
		const database = requireDb(this.database);
		const [row] = await database
			.select({ id: sessions.id })
			.from(sessions)
			.where(or(...matchers))
			.limit(1);
		return row?.id ?? null;
	}

  async getSessionFileOwner(sessionId: string): Promise<{
    id: string;
    userId: string;
    projectId: string | null;
    status?: SessionStatus;
    completedAt?: Date | null;
    stopRequestedAt?: Date | null;
  } | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({
				id: sessions.id,
				userId: sessions.userId,
				projectId: sessions.projectId,
        status: sessions.status,
        completedAt: sessions.completedAt,
        stopRequestedAt: sessions.stopRequestedAt,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
    return row ? { ...row, status: row.status as SessionStatus } : null;
	}

	async getSessionWorkflowContext(
		sessionId: string,
	): Promise<SessionWorkflowContext | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({
				workflowExecutionId: sessions.workflowExecutionId,
				parentExecutionId: sessions.parentExecutionId,
				daprInstanceId: sessions.daprInstanceId,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		return row ?? null;
	}

	async updateSessionStatus(input: UpdateSessionStatusInput): Promise<void> {
		const database = requireDb(this.database);
		const updatedAt = new Date();
		const patch: Partial<Session> & { updatedAt: Date } = {
			status: input.status,
			updatedAt,
		};
		if (input.stopReason !== undefined) {
			patch.stopReason = input.stopReason as Record<string, unknown> | null;
		}
		if (input.usage !== undefined) {
			patch.usage = input.usage as Record<string, unknown>;
		}
		if (input.errorMessage !== undefined) {
			patch.errorMessage = input.errorMessage ?? null;
		}
		if (input.pauseRequestedAt !== undefined) {
			patch.pauseRequestedAt = input.pauseRequestedAt;
		}
		if (input.markCompleted) patch.completedAt = updatedAt;
    await database.update(sessions).set(patch).where(eq(sessions.id, input.id));
	}

	async updateSessionStatusUnlessTerminated(
		input: UpdateSessionStatusUnlessTerminatedInput,
	): Promise<void> {
		const database = requireDb(this.database);
		const patch: Partial<Session> & { updatedAt: Date } = {
			status: input.status,
			updatedAt: new Date(),
		};
		if (input.stopReason !== undefined) {
			patch.stopReason = input.stopReason as Record<string, unknown> | null;
		}
		if (input.usage !== undefined) {
			patch.usage = input.usage as Record<string, unknown>;
		}
		if (input.errorMessage !== undefined) {
			patch.errorMessage = input.errorMessage ?? null;
		}
		await database
			.update(sessions)
			.set(patch)
			// Sticky-terminal guard: never flip a `terminated` row, and never
			// RESURRECT a crash-FINALIZED row (status='failed' AND completed_at set —
			// the liveness reconciler already purged its durable state). An
			// ingest-`failed` row (turn StopFailure, completed_at NULL) stays
			// non-sticky so a legitimate later status_running still recovers it.
			.where(
				and(
					eq(sessions.id, input.id),
					sql`${sessions.status} <> 'terminated'`,
					sql`NOT (${sessions.status} = 'failed' AND ${sessions.completedAt} IS NOT NULL)`,
				),
			);
	}

	async updateSessionStatusRescheduled(
		input: UpdateSessionStatusUnlessTerminatedInput,
	): Promise<void> {
		const database = requireDb(this.database);
		const patch: Partial<Session> & { updatedAt: Date } = {
			status: input.status,
			updatedAt: new Date(),
		};
		if (input.stopReason !== undefined) {
			patch.stopReason = input.stopReason as Record<string, unknown> | null;
		}
		if (input.usage !== undefined) {
			patch.usage = input.usage as Record<string, unknown>;
		}
		if (input.errorMessage !== undefined) {
			patch.errorMessage = input.errorMessage ?? null;
		}
		await database
			.update(sessions)
			.set(patch)
			// Sticky-terminal guards (same as updateSessionStatusUnlessTerminated)
			// PLUS a running guard: the runtime emits session.status_rescheduled at
			// session entry just before session.status_running, and ingestion can
			// deliver them out of order. A rescheduled event arriving after running
			// must not flip the row back — otherwise the session wedges at
			// rescheduling for its whole lifetime.
			.where(
				and(
					eq(sessions.id, input.id),
					sql`${sessions.status} <> 'terminated'`,
					sql`${sessions.status} <> 'running'`,
					sql`NOT (${sessions.status} = 'failed' AND ${sessions.completedAt} IS NOT NULL)`,
				),
			);
	}

	async bumpSessionLastEventAt(sessionId: string): Promise<void> {
		// Skip the round-trip when this pod already bumped inside the window.
		if (shouldSkipLastEventBump(sessionId, Date.now())) return;
		const database = requireDb(this.database);
		// Deliberately only sets last_event_at (never updated_at): this is a
		// liveness marker, not a mutation. The 5s guard caps it at one extra
		// UPDATE per session per window even under heartbeat-heavy ingest.
		await database
			.update(sessions)
			.set({ lastEventAt: sql`now()` })
			.where(
				and(
					eq(sessions.id, sessionId),
					sql`(${sessions.lastEventAt} IS NULL OR ${sessions.lastEventAt} < now() - interval '5 seconds')`,
				),
			);
	}

	async setSessionPendingInput(
		sessionId: string,
		value: PendingInput | null,
	): Promise<void> {
		const database = requireDb(this.database);
		// Pure cache write — like bumpSessionLastEventAt, deliberately does NOT
		// touch updated_at (a needs-input transition isn't a status mutation). The
		// ingest writer already serializes per session, so no guard is needed.
		await database
			.update(sessions)
			.set({ pendingInput: (value as Record<string, unknown> | null) ?? null })
			.where(eq(sessions.id, sessionId));
	}
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export class KubernetesSessionProvisioningReader implements SessionProvisioningReader {
	getSessionProvisioning(input: {
		sessionId: string;
		runtimeAppId?: string | null;
	}) {
    return getSessionProvisioningPreferObserver(
      input.sessionId,
      input.runtimeAppId,
    );
	}
}

export class DefaultSessionRuntimeConfigReader implements SessionRuntimeConfigReader {
	constructor(private readonly database: Database = requireDb()) {}

	getSessionRuntimeConfig(input: {
		sessionId: string;
		projectId?: string | null;
	}) {
		return getSessionRuntimeConfig(
			input.sessionId,
			{ projectId: input.projectId ?? null },
			{
				readLatestRuntimeConfigEvent: (sessionId) =>
					this.readLatestRuntimeConfigEvent(sessionId),
			},
		);
	}

	private async readLatestRuntimeConfigEvent(
		sessionId: string,
	): Promise<unknown | null> {
		const [row] = await this.database
			.select({ data: sessionEvents.data })
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, sessionId),
					eq(sessionEvents.type, RUNTIME_CONFIG_SESSION_EVENT_TYPE),
				),
			)
			.orderBy(desc(sessionEvents.sequence))
			.limit(1);
		return row?.data ?? null;
	}
}

export class SessionAgentConfigCommandAdapter implements SessionAgentConfigCommandPort {
	raiseSessionAgentConfigPatch(input: {
		sessionId: string;
		patch: unknown;
		session?: SessionDetail | null;
	}): Promise<SessionAgentConfigPatchResult> {
		return raiseSessionAgentConfigPatchForRuntime(
			input.sessionId,
			input.patch,
			input.session !== undefined
				? { getSession: async () => input.session ?? null }
				: undefined,
		).then((result) =>
			result.ok
				? {
						ok: true,
						status: result.status,
						patch: result.patch ?? {},
					}
				: {
						ok: false,
						status: result.status,
						error: result.error,
						patch: result.patch,
					},
		);
	}
}

export class DaprSessionRuntimeEventRaiser implements SessionRuntimeEventRaiser {
  raiseSessionUserEvents(
    sessionId: string,
    events: UserEvent[],
    delivery?: TeamMailboxDeliveryMetadata,
  ): Promise<SessionUserEventAcceptance> {
    return raiseSessionUserEvents(sessionId, events, delivery);
	}
}

export class DaprSessionWorkflowSpawner implements SessionWorkflowSpawner {
  reserveSessionWorkflow(
    sessionId: string,
  ): Promise<RuntimeProvisioningLease | null> {
    return reserveSessionWorkflow(sessionId);
  }

  releaseSessionWorkflow(
    sessionId: string,
    lease: RuntimeProvisioningLease,
  ): Promise<boolean> {
    return releaseSessionWorkflow(sessionId, lease);
  }

	spawnSessionWorkflow(
		sessionId: string,
    options?: {
      persistentHost?: boolean;
      provisioningLease?: RuntimeProvisioningLease;
      workflowMcpCapabilities?: {
        scriptDepth: number;
        teamId: string | null;
        teamRole: "none" | "lead" | "member";
      };
    },
	): Promise<{
		instanceId: string;
		natsSubject: string;
	}> {
		return spawnSessionWorkflow(sessionId, options);
	}
}

export class LifecycleSessionController implements SessionLifecycleController {
	constructor(
		private readonly goals?: SessionGoalStore,
    private readonly coordinatorOwners: SessionCoordinatorOwnerPort = new PostgresLifecycleCoordinatorOwnerStore(),
	) {}

	async checkSessionAccess(input: {
		sessionId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<{ status: "ok"; active: boolean } | { status: "not_found" }> {
		const inspected = await inspectDurableRun({
			kind: "session",
			id: input.sessionId,
		});
		if (inspected.notFound) return { status: "not_found" };
		if (
			inspected.scope &&
			!isResourceInScope(inspected.scope, {
				userId: input.userId,
				projectId: input.projectId ?? null,
			})
		) {
			return { status: "not_found" };
		}
		return { status: "ok", active: Boolean(inspected.active) };
	}

	pauseSession(sessionId: string) {
		return pauseDurableRun({ kind: "session", id: sessionId });
	}

	resumeSession(sessionId: string) {
		return resumeDurableRun({ kind: "session", id: sessionId });
	}

	stopSession(
		sessionId: string,
		opts: {
			mode: SessionLifecycleStopMode;
			reason?: string;
			graceMs?: number;
		},
	) {
		return stopDurableRun(
			{ kind: "session", id: sessionId },
			{ ...opts, mode: opts.mode as StopDurableRunMode },
		);
	}

	confirmSessionStop(sessionId: string) {
		return confirmDurableStop({ kind: "session", id: sessionId });
	}

	getCoordinatorOwner(sessionId: string) {
		return this.coordinatorOwners.getSessionCoordinatorOwner(sessionId);
	}

	async pauseSessionGoal(sessionId: string): Promise<void> {
		await (this.goals ?? new PostgresSessionGoalStore()).pauseGoal(sessionId);
	}
}

export class PostgresSessionGoalStore implements SessionGoalStore {
	constructor(private readonly database: Database = requireDb()) {}

	async getCurrentGoal(sessionId: string): Promise<SessionGoalRecord | null> {
		const rows = await this.database
			.select()
			.from(threadGoals)
			.where(eq(threadGoals.sessionId, sessionId))
			.orderBy(desc(threadGoals.createdAt))
			.limit(1);
		return toSessionGoalRecord(rows[0] ?? null);
	}

	async createOrReplaceGoal(
		input: CreateSessionGoalInput,
	): Promise<SessionGoalRecord> {
		const maxIterations =
			typeof input.maxIterations === "number" && input.maxIterations > 0
				? Math.floor(input.maxIterations)
				: 50;
		const tokenBudget =
			typeof input.tokenBudget === "number" && input.tokenBudget > 0
				? Math.floor(input.tokenBudget)
				: null;
		const acceptanceCriteria =
			Array.isArray(input.acceptanceCriteria) && input.acceptanceCriteria.length
				? input.acceptanceCriteria
				: null;
		const evidencePlan =
			input.evidencePlan &&
			Array.isArray(input.evidencePlan.commands) &&
			input.evidencePlan.commands.length
				? { commands: input.evidencePlan.commands }
				: null;

		const row = await this.database.transaction(async (tx) => {
			const existing = await tx
				.select()
				.from(threadGoals)
				.where(
					and(
						eq(threadGoals.sessionId, input.sessionId),
						inArray(threadGoals.status, ["active", "budget_limited"]),
					),
				)
				.orderBy(
					sql`case when ${threadGoals.status} = 'active' then 0 else 1 end`,
					desc(threadGoals.createdAt),
				)
				.limit(1);
			if (existing[0]) {
				const [updated] = await tx
					.update(threadGoals)
					.set({
						objective: input.objective,
						tokenBudget,
						maxIterations,
						acceptanceCriteria,
						evidencePlan,
						workflowExecutionId: input.workflowExecutionId ?? null,
						goalId: crypto.randomUUID(),
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						iterations: 0,
						budgetSteeredAt: null,
						lastContinuationAt: null,
						stopReason: null,
						completedAt: null,
						createdAt: new Date(),
						updatedAt: new Date(),
					})
					.where(eq(threadGoals.id, existing[0].id))
					.returning();
				return updated;
			}
			const [inserted] = await tx
				.insert(threadGoals)
				.values({
					sessionId: input.sessionId,
					objective: input.objective,
					tokenBudget,
					maxIterations,
					acceptanceCriteria,
					evidencePlan,
					workflowExecutionId: input.workflowExecutionId ?? null,
				})
				.returning();
			return inserted;
		});
		return toSessionGoalRecord(row)!;
	}

  async markGoalComplete(sessionId: string): Promise<SessionGoalRecord | null> {
		const [row] = await this.database
			.update(threadGoals)
			.set({
				status: "complete",
				stopReason: "complete",
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(threadGoals.sessionId, sessionId),
					inArray(threadGoals.status, ["active", "budget_limited"]),
				),
			)
			.returning();
		return toSessionGoalRecord(row ?? null);
	}

	async pauseGoal(sessionId: string): Promise<SessionGoalRecord | null> {
		const [row] = await this.database
			.update(threadGoals)
			.set({
				status: "paused",
				stopReason: "interrupt",
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(threadGoals.sessionId, sessionId),
					eq(threadGoals.status, "active"),
				),
			)
			.returning();
		return toSessionGoalRecord(row ?? null);
	}
}

export class DaprSessionGoalLoopDriver implements SessionGoalLoopDriver {
	constructor(
		private readonly goalLoopStore: GoalLoopStore = new PostgresGoalLoopStore(),
	) {}

	kickSessionGoalLoop(
		sessionId: string,
		opts?: Parameters<SessionGoalLoopDriver["kickSessionGoalLoop"]>[1],
	): Promise<void> {
		return kickGoalLoop(sessionId, opts, this.goalLoopStore);
	}
}

export class RuntimeSessionGoalHarnessResolver implements SessionGoalHarnessResolver {
	constructor(
		private readonly workflowData: () => Pick<
			WorkflowDataService,
			"getSessionRuntimeDebugTarget"
		>,
	) {}

	async sessionHasNativeGoalHarness(sessionId: string): Promise<boolean> {
		const target = await this.workflowData().getSessionRuntimeDebugTarget({
			sessionId,
		});
		if (!target) return false;
		return runtimeHasNativeGoalHarness(
			getRuntimeDescriptor(target.agentRuntime ?? undefined),
		);
	}

	decideGoalHarness(rawObjective: string, hasNativeHarness: boolean) {
		return decideGoalHarness(rawObjective, hasNativeHarness);
	}
}

export class LifecycleSessionGoalScopeGuard implements SessionGoalScopeGuard {
	async checkSessionScope(input: {
		sessionId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<"ok" | "not_found"> {
		const inspected = await inspectDurableRun({
			kind: "session",
			id: input.sessionId,
		});
		if (inspected.notFound) return "not_found";
		if (
			inspected.scope &&
			!isResourceInScope(inspected.scope, {
				userId: input.userId,
				projectId: input.projectId ?? null,
			})
		) {
			return "not_found";
		}
		return "ok";
	}
}

export class DaprSessionUserEventCommandAdapter implements SessionUserEventCommandPort {
	constructor(
		private readonly sessionEvents: SessionEventLog,
		private readonly runtimeEvents: SessionRuntimeEventRaiser,
	) {}

	async appendSessionUserEvents(input: {
		sessionId: string;
		projectId?: string | null;
		userId?: string | null;
		events: UserEvent[];
	}): Promise<"ok" | "not_found"> {
		for (const event of input.events) {
			await this.sessionEvents.appendSessionEvent(input.sessionId, {
				type: event.type,
				data: event as unknown as Record<string, unknown>,
				processedAt: null,
			});
		}

		try {
      await this.runtimeEvents.raiseSessionUserEvents(
        input.sessionId,
        input.events,
      );
		} catch (err) {
			console.warn("[sessions] raiseSessionUserEvents failed:", err);
		}

		return "ok";
	}
}

export class WorkspaceSessionRepositoryMounter implements SessionRepositoryMounter {
	mountSessionRepositories(
		sessionId: string,
		target: SessionRepositoryMountTarget,
	): Promise<void> {
		return mountSessionRepositories(sessionId, target);
	}

	mountSessionRepositoriesViaHost(
		sessionId: string,
		hostBaseUrl: string,
	): Promise<void> {
		return mountSessionRepositoriesViaHost(sessionId, hostBaseUrl);
	}

	mountSessionRepository(
		sessionId: string,
		resource: SessionResource,
		target: SessionRepositoryMountTarget,
	): Promise<void> {
		return mountSingleRepository(sessionId, resource, target);
	}
}

export class KubernetesSessionSandboxDestroyer implements SessionSandboxDestroyer {
  async deleteRuntimeSandbox(
    name: string,
  ): Promise<SessionSandboxDeleteResult> {
		try {
			const status = await deleteKubernetesSandbox(name);
			return {
				name,
				kind: "runtime",
				status: status === "deleted" ? "deleted" : "missing",
			};
		} catch (err) {
			return {
				name,
				kind: "runtime",
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

  async deleteWorkspaceSandbox(
    name: string,
  ): Promise<SessionSandboxDeleteResult> {
		try {
			const response = await openshellRuntimeFetch(
				`/api/v1/sandboxes/${encodeURIComponent(name)}`,
				{ method: "DELETE" },
			);
			if (response.ok) {
				return { name, kind: "workspace", status: "deleted" };
			}
			const detail = await response.text().catch(() => "");
			if (
				response.status === 404 ||
				detail.toLowerCase().includes("sandbox not found")
			) {
				return { name, kind: "workspace", status: "missing" };
			}
			return {
				name,
				kind: "workspace",
				status: "error",
				error:
					detail.slice(0, 500) ||
					response.statusText ||
					`HTTP ${response.status}`,
			};
		} catch (err) {
			return {
				name,
				kind: "workspace",
				status: "error",
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}
}

function toSessionGoalRecord(row: unknown): SessionGoalRecord | null {
	if (!row || typeof row !== "object") return null;
	const r = row as SessionGoalRecord;
	return {
		id: r.id,
		sessionId: r.sessionId,
		goalId: r.goalId,
		objective: r.objective,
		status: r.status,
		tokenBudget: r.tokenBudget,
		tokensUsed: r.tokensUsed,
		timeUsedSeconds: r.timeUsedSeconds,
		iterations: r.iterations,
		maxIterations: r.maxIterations,
		acceptanceCriteria: r.acceptanceCriteria,
		evidencePlan: r.evidencePlan,
		budgetSteeredAt: r.budgetSteeredAt,
		lastContinuationAt: r.lastContinuationAt,
		stopReason: r.stopReason,
		workflowExecutionId: r.workflowExecutionId,
		createdAt: r.createdAt,
		updatedAt: r.updatedAt,
		completedAt: r.completedAt,
	};
}
