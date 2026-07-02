import type {
	AppendSessionEventInput,
	CliWorkspaceSessionCandidateRecord,
	CreatePeerSessionInput,
	CreateWorkflowEnsureSessionInput,
	PeerSessionRecord,
	SessionBrowserTarget,
	SessionEventLog,
	SessionRepository,
	SessionTraceLifecycleStore,
	SessionWorkflowContext,
	UpdateSessionStatusInput,
	UpdateSessionStatusUnlessTerminatedInput,
	UpdateWorkflowEnsureSessionRuntimeInput,
	WorkflowEnsureSessionRecord,
	WorkflowSessionRuntimeHostRecord,
} from "$lib/server/application/ports";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import { agents, sessions, type Session } from "$lib/server/db/schema";
import {
	safeFinishMlflowRun,
	safePatchInteractiveSessionMlflowTraces,
} from "$lib/server/observability/mlflow-lifecycle";
import { appendEvent } from "$lib/server/sessions/events";
import { createSession, getSession } from "$lib/server/sessions/registry";
import type { SessionDetail, SessionEventEnvelope } from "$lib/types/sessions";

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

export class CurrentSessionRepository implements SessionRepository {
	constructor(private readonly database?: Database) {}

	getSession(id: string): Promise<SessionDetail | null> {
		return getSession(id);
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

	async getPeerSession(sessionId: string): Promise<PeerSessionRecord | null> {
		const session = await getSession(sessionId);
		return session ? toPeerSessionRecord(session) : null;
	}

	async createPeerSession(input: CreatePeerSessionInput): Promise<PeerSessionRecord> {
		const session = await createSession({
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

export class PostgresSessionEventLog implements SessionEventLog {
	appendSessionEvent(
		sessionId: string,
		event: AppendSessionEventInput,
	): Promise<SessionEventEnvelope> {
		return appendEvent(sessionId, event);
	}
}

export class LegacyMlflowSessionTraceLifecycle implements SessionTraceLifecycleStore {
	async patchInteractiveSessionTraces(input: {
		sessionId: string;
		status: "OK" | "ERROR";
	}): Promise<void> {
		await safePatchInteractiveSessionMlflowTraces(input);
	}
}
