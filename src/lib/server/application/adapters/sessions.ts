import type {
	AddSessionResourceInput,
	AttachSessionRuntimeInput,
	AppendSessionEventInput,
	CliWorkspaceSessionCandidateRecord,
	CreateSessionForkInput,
	CreateSessionRecordInput,
	CreatePeerSessionInput,
	CreateSessionGoalInput,
	CreateWorkflowEnsureSessionInput,
	ListSessionEventsInput,
	PeerSessionRecord,
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
	SessionSandboxDeleteResult,
	SessionSandboxDestroyer,
	SessionTraceLifecycleStore,
	SessionUserEventCommandPort,
	SessionListInput,
	SessionWorkflowSpawner,
	SessionWorkflowContext,
	WorkflowDataService,
	UpdateSessionStatusInput,
	UpdateSessionStatusUnlessTerminatedInput,
	UpdateWorkflowEnsureSessionRuntimeInput,
	WorkflowEnsureSessionRecord,
	WorkflowExecutionSessionRuntimeRecord,
	WorkflowSessionRuntimeHostRecord,
} from "$lib/server/application/ports";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	agents,
	projects,
	sessionEvents,
	sessionResources,
	sessions,
	threadGoals,
	type Session,
	type SessionResource as SessionResourceRow,
} from "$lib/server/db/schema";
import {
	safeFinishMlflowRun,
	safeCreateInteractiveSessionMlflowRun,
	safePatchInteractiveSessionMlflowTraces,
} from "$lib/server/observability/mlflow-lifecycle";
import { appendEvent, rowToEnvelope } from "$lib/server/sessions/events";
import {
	attachWorkspaceSandbox,
	createSession as createSessionRecord,
	getSession,
	listSessions,
	recordSessionSandboxProvisioningError,
} from "$lib/server/sessions/registry";
import { raiseSessionAgentConfigPatch as raiseSessionAgentConfigPatchForRuntime } from "$lib/server/sessions/agent-config-patch";
import { getSessionProvisioningPreferObserver } from "$lib/server/sessions/provisioning";
import {
	getSessionRuntimeConfig,
	RUNTIME_CONFIG_SESSION_EVENT_TYPE,
} from "$lib/server/sessions/runtime-config";
import {
	raiseSessionUserEvents,
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
import {
	pauseDurableRun,
	resumeDurableRun,
} from "$lib/server/lifecycle/pause";
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
	SessionDetail,
	SessionEventEnvelope,
	SessionResource,
	SessionResourceType,
	UserEvent,
} from "$lib/types/sessions";

type Database = typeof defaultDb;

function requireDb(database: Database = defaultDb): Database {
	if (!database) throw new Error("Database not configured");
	return database;
}

function toPeerSessionRecord(session: SessionDetail): PeerSessionRecord {
	return {
		id: session.id,
		agentId: session.agentId,
		agentVersion: session.agentVersion,
		environmentId: session.environmentId,
		environmentVersion: session.environmentVersion,
		vaultIds: session.vaultIds,
		daprInstanceId: session.daprInstanceId,
		natsSubject: session.natsSubject,
	};
}

function toWorkflowEnsureSessionRecord(
	session: SessionDetail,
): WorkflowEnsureSessionRecord {
	return {
		id: session.id,
		agentId: session.agentId,
		agentVersion: session.agentVersion,
		vaultIds: session.vaultIds,
		workflowExecutionId: session.workflowExecutionId,
		sandboxName: session.sandboxName,
		runtimeAppId: session.runtimeAppId,
		runtimeSandboxName: session.runtimeSandboxName,
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

export class CurrentSessionRepository implements SessionRepository {
	constructor(private readonly database?: Database) {}

	listSessions(filter: SessionListInput = {}) {
		return listSessions({
			...filter,
			projectId: filter.projectId ?? undefined,
		});
	}

	getSession(id: string): Promise<SessionDetail | null> {
		return getSession(id);
	}

	createSession(input: CreateSessionRecordInput): Promise<SessionDetail> {
		return createSessionRecord(input);
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
			.returning({ id: sessions.id, mlflowRunId: sessions.mlflowRunId });
		if (row?.mlflowRunId) {
			void safeFinishMlflowRun({
				runId: row.mlflowRunId,
				status: "KILLED",
				endTime: archivedAt,
			});
		}
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
	}): Promise<void> {
		await attachWorkspaceSandbox(input.sessionId, input.workspaceSandboxName);
	}

	async recordSandboxProvisioningError(input: {
		sessionId: string;
		errorMessage: string;
	}): Promise<void> {
		await recordSessionSandboxProvisioningError(
			input.sessionId,
			input.errorMessage,
		);
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

	async attachSessionRuntime(input: AttachSessionRuntimeInput): Promise<void> {
		const database = requireDb(this.database);
		const patch: Partial<Session> & { updatedAt: Date } = {
			updatedAt: new Date(),
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
		await database
			.update(sessions)
			.set(patch)
			.where(eq(sessions.id, input.sessionId));
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
		const names = [...new Set(input.sandboxNames.map((name) => name.trim()).filter(Boolean))];
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
		const session = await getSession(sessionId);
		return session ? toWorkflowEnsureSessionRecord(session) : null;
	}

	async createWorkflowEnsureSession(input: CreateWorkflowEnsureSessionInput): Promise<void> {
		const database = requireDb(this.database);
		await database.insert(sessions).values({
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
		});
	}

	async updateWorkflowEnsureSessionRuntime(
		input: UpdateWorkflowEnsureSessionRuntimeInput,
	): Promise<void> {
		const database = requireDb(this.database);
		await database
			.update(sessions)
			.set({
				runtimeAppId: input.runtimeAppId,
				runtimeSandboxName: input.runtimeSandboxName,
				updatedAt: new Date(),
			})
			.where(eq(sessions.id, input.sessionId));
	}

	async listTerminalWorkflowSessionRuntimeHosts(input: {
		workflowExecutionId: string;
	}): Promise<WorkflowSessionRuntimeHostRecord[]> {
		const database = requireDb(this.database);
		const rows = await database
			.select({ id: sessions.id, runtimeAppId: sessions.runtimeAppId })
			.from(sessions)
			.where(
				and(
					eq(sessions.workflowExecutionId, input.workflowExecutionId),
					inArray(sessions.status, ["terminated", "failed"]),
					isNotNull(sessions.runtimeAppId),
				),
			);
		return rows.flatMap((row) =>
			row.runtimeAppId
				? [{ sessionId: row.id, runtimeAppId: row.runtimeAppId }]
			: [],
		);
	}

	async createSessionFork(input: CreateSessionForkInput): Promise<{ id: string }> {
		const session = await createSessionRecord({
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
		const session = await getSession(sessionId);
		return session ? toPeerSessionRecord(session) : null;
	}

	async createPeerSession(input: CreatePeerSessionInput): Promise<PeerSessionRecord> {
		const session = await createSessionRecord({
			id: input.id,
			agentId: input.agentId,
			title: input.title,
			userId: input.userId,
			projectId: input.projectId,
			parentExecutionId: input.parentExecutionId,
		});
		return toPeerSessionRecord(session);
	}

	async findSessionIdByDaprInstanceId(instanceId: string): Promise<string | null> {
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
			matchers.push(eq(sessions.id, sessionId), eq(sessions.daprInstanceId, sessionId));
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

	async getSessionFileOwner(
		sessionId: string,
	): Promise<{ id: string; userId: string; projectId: string | null } | null> {
		const database = requireDb(this.database);
		const [row] = await database
			.select({
				id: sessions.id,
				userId: sessions.userId,
				projectId: sessions.projectId,
			})
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1);
		return row ?? null;
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
		const [row] = await database
			.update(sessions)
			.set(patch)
			.where(eq(sessions.id, input.id))
			.returning({ mlflowRunId: sessions.mlflowRunId });
		if (input.markCompleted && row?.mlflowRunId) {
			void safeFinishMlflowRun({
				runId: row.mlflowRunId,
				status: input.status === "terminated" ? "FINISHED" : "FAILED",
				endTime: patch.completedAt ?? patch.updatedAt,
			});
		}
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
			.where(and(eq(sessions.id, input.id), sql`${sessions.status} <> 'terminated'`));
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
		return getSessionProvisioningPreferObserver(input.sessionId, input.runtimeAppId);
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

export class SessionAgentConfigCommandAdapter
	implements SessionAgentConfigCommandPort
{
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

export class PostgresSessionEventLog implements SessionEventLog {
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope> {
		return appendEvent(sessionId, event);
	}

	async getSessionEvent(input: {
		sessionId: string;
		eventId: string;
	}): Promise<SessionEventEnvelope | null> {
		const database = requireDb();
		const [row] = await database
			.select()
			.from(sessionEvents)
			.where(
				and(
					eq(sessionEvents.sessionId, input.sessionId),
					eq(sessionEvents.id, input.eventId),
				),
			)
			.limit(1);
		return row ? rowToEnvelope(row, { preview: false }) : null;
	}

	async listSessionEvents(
		sessionId: string,
		input: ListSessionEventsInput = {},
	): Promise<SessionEventEnvelope[]> {
		const database = requireDb();
		const conditions = [eq(sessionEvents.sessionId, sessionId)];
		if (typeof input.afterSequence === "number") {
			conditions.push(gt(sessionEvents.sequence, input.afterSequence));
		}
		if (typeof input.atOrBeforeSequence === "number") {
			conditions.push(lte(sessionEvents.sequence, input.atOrBeforeSequence));
		}

		const query = database
			.select()
			.from(sessionEvents)
			.where(and(...conditions))
			.orderBy(asc(sessionEvents.sequence));
		const rows =
			typeof input.limit === "number"
				? await query.limit(Math.max(1, Math.trunc(input.limit)))
				: await query;
		return rows.map((row) => rowToEnvelope(row, { preview: input.preview }));
	}
}

export class DaprSessionRuntimeEventRaiser implements SessionRuntimeEventRaiser {
	raiseSessionUserEvents(sessionId: string, events: UserEvent[]): Promise<void> {
		return raiseSessionUserEvents(sessionId, events);
	}
}

export class DaprSessionWorkflowSpawner implements SessionWorkflowSpawner {
	spawnSessionWorkflow(sessionId: string): Promise<{
		instanceId: string;
		natsSubject: string;
	}> {
		return spawnSessionWorkflow(sessionId);
	}
}

export class LifecycleSessionController implements SessionLifecycleController {
	constructor(
		private readonly goals?: SessionGoalStore,
		private readonly coordinatorOwners: SessionCoordinatorOwnerPort =
			new PostgresLifecycleCoordinatorOwnerStore(),
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

	async markGoalComplete(
		sessionId: string,
	): Promise<SessionGoalRecord | null> {
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
	kickSessionGoalLoop(
		sessionId: string,
		opts?: Parameters<SessionGoalLoopDriver["kickSessionGoalLoop"]>[1],
	): Promise<void> {
		return kickGoalLoop(sessionId, opts);
	}
}

export class RuntimeSessionGoalHarnessResolver
	implements SessionGoalHarnessResolver
{
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

export class DaprSessionUserEventCommandAdapter
	implements SessionUserEventCommandPort
{
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
			await this.runtimeEvents.raiseSessionUserEvents(input.sessionId, input.events);
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
	async deleteRuntimeSandbox(name: string): Promise<SessionSandboxDeleteResult> {
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

	async deleteWorkspaceSandbox(name: string): Promise<SessionSandboxDeleteResult> {
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

export class LegacyMlflowSessionTraceLifecycle implements SessionTraceLifecycleStore {
	createInteractiveSessionTraceRun(
		input: Parameters<NonNullable<SessionTraceLifecycleStore["createInteractiveSessionTraceRun"]>>[0],
	) {
		return safeCreateInteractiveSessionMlflowRun(input);
	}

	async patchInteractiveSessionTraces(input: {
		sessionId: string;
		status: "OK" | "ERROR";
	}): Promise<void> {
		await safePatchInteractiveSessionMlflowTraces(input);
	}
}
