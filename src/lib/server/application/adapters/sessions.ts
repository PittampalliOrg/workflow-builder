import type {
	AddSessionResourceInput,
	AppendSessionEventInput,
	CliWorkspaceSessionCandidateRecord,
	CreateSessionForkInput,
	CreateSessionRecordInput,
	CreatePeerSessionInput,
	CreateWorkflowEnsureSessionInput,
	ListSessionEventsInput,
	PeerSessionRecord,
	SessionAgentConfigCommandPort,
	SessionAgentConfigPatchResult,
	SessionBrowserTarget,
	SessionContextUsageReadModel,
	SessionEventLog,
	SessionProvisioningContext,
	SessionProvisioningReader,
	SessionRepository,
	SessionRepositoryMountTarget,
	SessionRepositoryMounter,
	SessionRuntimeDebugTarget,
	SessionRuntimeConfigReader,
	SessionRuntimeEventRaiser,
	SessionTraceLifecycleStore,
	SessionListInput,
	SessionWorkflowSpawner,
	SessionWorkflowContext,
	UpdateSessionStatusInput,
	UpdateSessionStatusUnlessTerminatedInput,
	UpdateWorkflowEnsureSessionRuntimeInput,
	WorkflowEnsureSessionRecord,
	WorkflowSessionRuntimeHostRecord,
} from "$lib/server/application/ports";
import { and, asc, desc, eq, gt, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	agents,
	sessionEvents,
	sessionResources,
	sessions,
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
import { getSessionRuntimeConfig } from "$lib/server/sessions/runtime-config";
import {
	raiseSessionUserEvents,
	spawnSessionWorkflow,
} from "$lib/server/sessions/spawn";
import {
	mountSessionRepositories,
	mountSingleRepository,
} from "$lib/server/sessions/repositories";
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
	getSessionRuntimeConfig(input: {
		sessionId: string;
		projectId?: string | null;
	}) {
		return getSessionRuntimeConfig(input.sessionId, {
			projectId: input.projectId ?? null,
		});
	}
}

export class SessionAgentConfigCommandAdapter
	implements SessionAgentConfigCommandPort
{
	raiseSessionAgentConfigPatch(input: {
		sessionId: string;
		patch: unknown;
	}): Promise<SessionAgentConfigPatchResult> {
		return raiseSessionAgentConfigPatchForRuntime(
			input.sessionId,
			input.patch,
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

export class WorkspaceSessionRepositoryMounter implements SessionRepositoryMounter {
	mountSessionRepositories(
		sessionId: string,
		target: SessionRepositoryMountTarget,
	): Promise<void> {
		return mountSessionRepositories(sessionId, target);
	}

	mountSessionRepository(
		sessionId: string,
		resource: SessionResource,
		target: SessionRepositoryMountTarget,
	): Promise<void> {
		return mountSingleRepository(sessionId, resource, target);
	}
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
