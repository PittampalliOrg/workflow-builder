import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	agents,
	sessions,
	sessionResources,
	workflowExecutions,
	workflows,
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

type JoinContext = {
	workflowId: string | null;
	workflowName: string | null;
	agentName: string | null;
	agentSlug: string | null;
	agentAvatar: string | null;
	agentTags: string[] | null;
};

const EMPTY_CTX: JoinContext = {
	workflowId: null,
	workflowName: null,
	agentName: null,
	agentSlug: null,
	agentAvatar: null,
	agentTags: null,
};

function rowToSummary(
	row: Session,
	ctx: JoinContext = EMPTY_CTX,
): SessionSummary {
	const agentTags = Array.isArray(ctx.agentTags) ? ctx.agentTags : [];
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
		workflowId: ctx.workflowId,
		workflowName: ctx.workflowName,
		agentName: ctx.agentName,
		agentSlug: ctx.agentSlug,
		agentAvatar: ctx.agentAvatar,
		agentEphemeral: agentTags.includes("workflow-ephemeral"),
		createdAt: row.createdAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
		completedAt: row.completedAt ? row.completedAt.toISOString() : null,
		archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
	};
}

function rowToDetail(row: Session, ctx: JoinContext = EMPTY_CTX): SessionDetail {
	return {
		...rowToSummary(row, ctx),
		daprInstanceId: row.daprInstanceId ?? null,
		natsSubject: row.natsSubject ?? null,
		parentExecutionId: row.parentExecutionId ?? null,
		sandboxName: row.sandboxName ?? null,
		workspaceSandboxName: row.workspaceSandboxName ?? null,
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
	/** Scope to a specific workspace/project. When set, non-matching
	 * sessions are excluded even if they belong to the same user — matches
	 * CMA's workspace-isolation model. */
	projectId?: string;
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
	if (filter.projectId)
		conditions.push(eq(sessions.projectId, filter.projectId));
	if (filter.agentId) conditions.push(eq(sessions.agentId, filter.agentId));
	if (filter.status) conditions.push(eq(sessions.status, filter.status));
	if (!filter.includeArchived) {
		conditions.push(sql`${sessions.archivedAt} IS NULL` as unknown as ReturnType<
			typeof eq
		>);
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
		.limit(filter.limit ?? 100);
	return rows.map((r) =>
		rowToSummary(r.session, {
			workflowId: r.workflowId ?? null,
			workflowName: r.workflowName ?? null,
			agentName: r.agentName ?? null,
			agentSlug: r.agentSlug ?? null,
			agentAvatar: r.agentAvatar ?? null,
			agentTags: (r.agentTags as string[] | null) ?? null,
		}),
	);
}

export async function getSession(id: string): Promise<SessionDetail | null> {
	const database = requireDb();
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
		? rowToDetail(row.session, {
				workflowId: row.workflowId ?? null,
				workflowName: row.workflowName ?? null,
				agentName: row.agentName ?? null,
				agentSlug: row.agentSlug ?? null,
				agentAvatar: row.agentAvatar ?? null,
				agentTags: (row.agentTags as string[] | null) ?? null,
			})
		: null;
}

export type CreateSessionInput = {
	/**
	 * Optional deterministic session id. When supplied, the insert uses it
	 * verbatim instead of generating a fresh id — letting callers key on
	 * their own identifier (e.g. parent workflow + tool-call-id). Used by
	 * peer-agent spawns from CallAgent to stay replay-idempotent. Must be
	 * ≤64 chars to fit Dapr's workflow instance-id cap if reused there.
	 */
	id?: string;
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
	sandboxName?: string | null;
};

/**
 * Default Dapr app that executes `durable/run` sessions. The sandbox detail
 * UI filters on `sessions.sandbox_name`; since every UI-initiated session
 * currently routes to `dapr-agent-py`, we tag new sessions with that name
 * unless the caller overrides (e.g., the testing deployment).
 */
const DEFAULT_SANDBOX_NAME = "dapr-agent-py";

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
	};
	const [row] = await database.insert(sessions).values(values).returning();
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

/** Record the per-session OpenShell sandbox name after provisioning. */
export async function attachWorkspaceSandbox(
	id: string,
	workspaceSandboxName: string,
): Promise<void> {
	const database = requireDb();
	await database
		.update(sessions)
		.set({ workspaceSandboxName, updatedAt: new Date() })
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
