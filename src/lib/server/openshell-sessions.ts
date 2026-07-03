import { and, eq, or } from "drizzle-orm";

import { db } from "$lib/server/db";
import { sessions, workflowExecutions } from "$lib/server/db/schema";
import { isResourceInScope } from "$lib/server/workflows/project-scope";
import {
	attachWorkspaceSandbox,
	createSession,
	getSession,
	type CreateSessionInput,
} from "$lib/server/sessions/registry";
import { spawnSessionWorkflow } from "$lib/server/sessions/spawn";

export type OpenShellCaller = {
	userId: string;
	projectId?: string | null;
};

type SessionRow = typeof sessions.$inferSelect;

export type OpenShellSessionView = {
	id: string;
	state: string;
	terminalAvailable: boolean;
	sandboxName: string | null;
	workspaceSandboxName: string | null;
	runtimeSandboxName: string | null;
	workflowExecutionId: string | null;
	daprInstanceId: string | null;
	executionClass: string;
	links: {
		session: string;
		workflowExecution: string | null;
		trace: string | null;
	};
};

function requireDb() {
	if (!db) throw new Error("Database not configured");
	return db;
}

function validateTerminalId(terminalId: string): void {
	if (!/^[A-Za-z0-9._:-]{1,128}$/.test(terminalId)) {
		throw new Error("Invalid terminal id");
	}
}

function terminalSandboxName(row: SessionRow): string | null {
	return row.workspaceSandboxName || row.runtimeSandboxName || null;
}

function toView(row: SessionRow): OpenShellSessionView {
	const sandboxName = terminalSandboxName(row);
	return {
		id: row.id,
		state: row.status,
		terminalAvailable: Boolean(sandboxName),
		sandboxName,
		workspaceSandboxName: row.workspaceSandboxName ?? null,
		runtimeSandboxName: row.runtimeSandboxName ?? null,
		workflowExecutionId: row.workflowExecutionId ?? null,
		daprInstanceId: row.daprInstanceId ?? null,
		executionClass: "interactive-agent",
		links: {
			session: `/api/v1/sessions/${encodeURIComponent(row.id)}`,
			workflowExecution: row.workflowExecutionId
				? `/api/workflows/executions/${encodeURIComponent(row.workflowExecutionId)}`
				: null,
			trace: null,
		},
	};
}

async function assertWorkflowExecutionInScope(
	workflowExecutionId: string | null | undefined,
	caller: OpenShellCaller,
): Promise<void> {
	if (!workflowExecutionId) return;
	const database = requireDb();
	const [row] = await database
		.select()
		.from(workflowExecutions)
		.where(eq(workflowExecutions.id, workflowExecutionId))
		.limit(1);
	if (!row || !isResourceInScope(row, caller)) {
		const err = new Error("Workflow execution not found");
		(err as Error & { status?: number }).status = 404;
		throw err;
	}
}

export async function getOpenShellSession(
	sessionId: string,
	caller: OpenShellCaller,
): Promise<OpenShellSessionView | null> {
	const database = requireDb();
	const [row] = await database
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!row) return null;
	if (!isResourceInScope(row, caller)) return null;
	return toView(row);
}

export async function resolveOpenShellTerminalTarget(
	sessionId: string,
	terminalId: string,
	caller: OpenShellCaller,
): Promise<{ sandboxName: string; terminalId: string; session: OpenShellSessionView } | null> {
	validateTerminalId(terminalId);
	const database = requireDb();
	const [row] = await database
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1);
	if (!row || !isResourceInScope(row, caller)) return null;
	const sandboxName = terminalSandboxName(row);
	if (!sandboxName) {
		const err = new Error("No OpenShell sandbox is attached to this session");
		(err as Error & { status?: number }).status = 409;
		throw err;
	}
	return { sandboxName, terminalId, session: toView(row) };
}

async function findAttachedSession(params: {
	caller: OpenShellCaller;
	workflowExecutionId?: string | null;
	sandboxName?: string | null;
}): Promise<SessionRow | null> {
	const sandboxName = params.sandboxName?.trim();
	if (!sandboxName && !params.workflowExecutionId) return null;

	const conditions = [];
	if (params.caller.projectId) {
		conditions.push(eq(sessions.projectId, params.caller.projectId));
	} else {
		conditions.push(eq(sessions.userId, params.caller.userId));
	}
	if (params.workflowExecutionId) {
		conditions.push(eq(sessions.workflowExecutionId, params.workflowExecutionId));
	}
	if (sandboxName) {
		conditions.push(
			or(
				eq(sessions.workspaceSandboxName, sandboxName),
				eq(sessions.runtimeSandboxName, sandboxName),
				eq(sessions.sandboxName, sandboxName),
			)!,
		);
	}

	const database = requireDb();
	const [row] = await database
		.select()
		.from(sessions)
		.where(and(...conditions))
		.limit(1);
	return row ?? null;
}

export async function createOrAttachOpenShellSession(
	body: Record<string, unknown>,
	caller: OpenShellCaller,
): Promise<OpenShellSessionView> {
	const requestedSessionId =
		typeof body.sessionId === "string" ? body.sessionId.trim() : "";
	if (requestedSessionId) {
		const existing = await getOpenShellSession(requestedSessionId, caller);
		if (!existing) {
			const err = new Error("Session not found");
			(err as Error & { status?: number }).status = 404;
			throw err;
		}
		return existing;
	}

	const workflowExecutionId =
		typeof body.workflowExecutionId === "string"
			? body.workflowExecutionId.trim()
			: null;
	await assertWorkflowExecutionInScope(workflowExecutionId, caller);

	const sandboxName =
		typeof body.sandboxName === "string" ? body.sandboxName.trim() : null;
	const attached = await findAttachedSession({
		caller,
		workflowExecutionId,
		sandboxName,
	});
	if (attached) return toView(attached);

	const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
	if (!agentId) {
		const err = new Error(
			"agentId is required when no existing OpenShell session can be attached",
		);
		(err as Error & { status?: number }).status = 400;
		throw err;
	}

	const createInput: CreateSessionInput = {
		agentId,
		agentVersion:
			typeof body.agentVersion === "number" ? body.agentVersion : undefined,
		environmentId:
			typeof body.environmentId === "string" ? body.environmentId : undefined,
		environmentVersion:
			typeof body.environmentVersion === "number"
				? body.environmentVersion
				: undefined,
		title:
			typeof body.title === "string" && body.title.trim()
				? body.title.trim()
				: sandboxName
					? `OpenShell ${sandboxName}`
					: "OpenShell session",
		userId: caller.userId,
		projectId: caller.projectId ?? null,
		workflowExecutionId,
	};
	const created = await createSession(createInput);
	if (sandboxName) {
		await attachWorkspaceSandbox(created.id, sandboxName);
	}
	if (body.spawnWorkflow === true) {
		await spawnSessionWorkflow(created.id);
	}
	const detail = await getSession(created.id);
	const database = requireDb();
	const [row] = await database
		.select()
		.from(sessions)
		.where(eq(sessions.id, detail?.id ?? created.id))
		.limit(1);
	return toView(row);
}
