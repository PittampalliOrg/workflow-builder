import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	sessions,
	sessionResources,
	type Session,
	type SessionResource as SessionResourceRow,
} from "$lib/server/db/schema";
import type {
	SessionDetail,
	SessionResource,
	SessionResourceType,
	SessionStatus,
	SessionStopReason,
	SessionSummary,
	SessionUsage,
} from "$lib/types/sessions";
import { resolveAgentRef } from "$lib/server/agents/registry";

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function rowToSummary(row: Session): SessionSummary {
	return {
		id: row.id,
		title: row.title ?? null,
		status: row.status as SessionStatus,
		stopReason: (row.stopReason as SessionStopReason | null) ?? null,
		agentId: row.agentId,
		agentVersion: row.agentVersion ?? null,
		environmentId: row.environmentId ?? null,
		environmentVersion: row.environmentVersion ?? null,
		vaultIds: Array.isArray(row.vaultIds) ? row.vaultIds : [],
		usage: (row.usage as SessionUsage) ?? {},
		errorMessage: row.errorMessage ?? null,
		workflowExecutionId: row.workflowExecutionId ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		completedAt: row.completedAt ? row.completedAt.toISOString() : null,
		archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
	};
}

function rowToDetail(row: Session): SessionDetail {
	return {
		...rowToSummary(row),
		daprInstanceId: row.daprInstanceId ?? null,
		natsSubject: row.natsSubject ?? null,
		parentExecutionId: row.parentExecutionId ?? null,
	};
}

function resourceRowToDto(row: SessionResourceRow): SessionResource {
	return {
		id: row.id,
		sessionId: row.sessionId,
		type: row.type as SessionResourceType,
		fileId: row.fileId ?? null,
		mountPath: row.mountPath ?? null,
		repoUrl: row.repoUrl ?? null,
		checkoutRef: row.checkoutRef ?? null,
		authTokenCredentialId: row.authTokenCredentialId ?? null,
		mountedAt: row.mountedAt ? row.mountedAt.toISOString() : null,
		removedAt: row.removedAt ? row.removedAt.toISOString() : null,
	};
}

export type ListSessionsFilter = {
	userId?: string;
	agentId?: string;
	status?: SessionStatus;
	includeArchived?: boolean;
	limit?: number;
};

export async function listSessions(
	filter: ListSessionsFilter = {},
): Promise<SessionSummary[]> {
	const database = requireDb();
	const conditions: ReturnType<typeof eq>[] = [];
	if (filter.userId) conditions.push(eq(sessions.userId, filter.userId));
	if (filter.agentId) conditions.push(eq(sessions.agentId, filter.agentId));
	if (filter.status) conditions.push(eq(sessions.status, filter.status));
	if (!filter.includeArchived) {
		conditions.push(sql`${sessions.archivedAt} IS NULL` as unknown as ReturnType<
			typeof eq
		>);
	}

	const rows = await database
		.select()
		.from(sessions)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(desc(sessions.createdAt))
		.limit(filter.limit ?? 100);
	return rows.map(rowToSummary);
}

export async function getSession(id: string): Promise<SessionDetail | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(sessions)
		.where(eq(sessions.id, id))
		.limit(1);
	return row ? rowToDetail(row) : null;
}

export type CreateSessionInput = {
	agentId: string;
	agentVersion?: number;
	environmentId?: string;
	environmentVersion?: number;
	vaultIds?: string[];
	title?: string;
	userId: string;
	projectId?: string | null;
	workflowExecutionId?: string | null;
	parentExecutionId?: string | null;
};

/**
 * Create a session and pin it to the agent's current (or explicitly-chosen)
 * version. Also resolves the agent's default environment + vaults when
 * those aren't specified. The Dapr workflow instance isn't started here —
 * the caller is responsible for posting to the orchestrator after insert
 * and then calling {@link attachRuntime} to record the instance id +
 * NATS subject.
 */
export async function createSession(
	input: CreateSessionInput,
): Promise<SessionDetail> {
	const database = requireDb();
	const resolvedAgent = await resolveAgentRef({
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

	const [row] = await database
		.insert(sessions)
		.values({
			title: input.title ?? null,
			status: "rescheduling",
			agentId: resolvedAgent.id,
			agentVersion: resolvedAgent.version,
			environmentId: environmentId ?? null,
			environmentVersion,
			vaultIds,
			userId: input.userId,
			projectId: input.projectId ?? null,
			workflowExecutionId: input.workflowExecutionId ?? null,
			parentExecutionId: input.parentExecutionId ?? null,
		})
		.returning();
	return rowToDetail(row);
}

export async function attachRuntime(
	id: string,
	params: { daprInstanceId?: string; natsSubject?: string },
): Promise<void> {
	const database = requireDb();
	await database
		.update(sessions)
		.set({
			daprInstanceId: params.daprInstanceId,
			natsSubject: params.natsSubject,
			updatedAt: new Date(),
		})
		.where(eq(sessions.id, id));
}

export async function updateSessionStatus(
	id: string,
	status: SessionStatus,
	extras: {
		stopReason?: SessionStopReason | null;
		usage?: SessionUsage;
		errorMessage?: string | null;
		markCompleted?: boolean;
	} = {},
): Promise<void> {
	const database = requireDb();
	const patch: Partial<Session> & { updatedAt: Date } = {
		status,
		updatedAt: new Date(),
	};
	if (extras.stopReason !== undefined)
		patch.stopReason = extras.stopReason as Record<string, unknown> | null;
	if (extras.usage !== undefined)
		patch.usage = extras.usage as Record<string, unknown>;
	if (extras.errorMessage !== undefined)
		patch.errorMessage = extras.errorMessage ?? null;
	if (extras.markCompleted) patch.completedAt = new Date();
	await database.update(sessions).set(patch).where(eq(sessions.id, id));
}

export async function updateSessionTitle(
	id: string,
	title: string,
): Promise<SessionDetail | null> {
	const database = requireDb();
	const [row] = await database
		.update(sessions)
		.set({ title, updatedAt: new Date() })
		.where(eq(sessions.id, id))
		.returning();
	return row ? rowToDetail(row) : null;
}

export async function archiveSession(id: string): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.update(sessions)
		.set({ archivedAt: new Date(), updatedAt: new Date() })
		.where(eq(sessions.id, id))
		.returning({ id: sessions.id });
	return Boolean(row);
}

export async function deleteSession(id: string): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.delete(sessions)
		.where(eq(sessions.id, id))
		.returning({ id: sessions.id });
	return Boolean(row);
}

export type AddResourceInput = {
	type: SessionResourceType;
	fileId?: string;
	mountPath?: string;
	repoUrl?: string;
	checkoutRef?: string;
	authTokenCredentialId?: string;
};

export async function addResource(
	sessionId: string,
	input: AddResourceInput,
): Promise<SessionResource> {
	const database = requireDb();
	const [row] = await database
		.insert(sessionResources)
		.values({
			sessionId,
			type: input.type,
			fileId: input.fileId ?? null,
			mountPath: input.mountPath ?? null,
			repoUrl: input.repoUrl ?? null,
			checkoutRef: input.checkoutRef ?? null,
			authTokenCredentialId: input.authTokenCredentialId ?? null,
		})
		.returning();
	return resourceRowToDto(row);
}

export async function listResources(
	sessionId: string,
): Promise<SessionResource[]> {
	const database = requireDb();
	const rows = await database
		.select()
		.from(sessionResources)
		.where(eq(sessionResources.sessionId, sessionId))
		.orderBy(asc(sessionResources.mountPath));
	return rows.map(resourceRowToDto);
}

export async function removeResource(
	sessionId: string,
	resourceId: string,
): Promise<boolean> {
	const database = requireDb();
	const [row] = await database
		.delete(sessionResources)
		.where(
			and(
				eq(sessionResources.sessionId, sessionId),
				eq(sessionResources.id, resourceId),
			),
		)
		.returning({ id: sessionResources.id });
	return Boolean(row);
}
