import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import {
	sessions,
	workflowExecutions,
	workflows,
	workflowWorkspaceSessions,
} from "$lib/server/db/schema";
import {
	DEV_PREVIEW_SERVICES,
	resolveDevPreviewDescriptor,
} from "$lib/server/workflows/dev-preview-registry";

/**
 * Read model for the Dev hub. A "dev environment" = a per-run dev-preview pod
 * (a `workflow_workspace_sessions` row with `details.kind='dev-preview'`) plus
 * the interactive coding-agent session the run handed off into (linked via
 * `sessions.workflow_execution_id`). Both are produced by the
 * `microservice-dev-session` workflow; the hub only READS them back here.
 */
export interface DevEnvironmentSummary {
	executionId: string;
	workspaceRef: string;
	service: string;
	browseUrl: string | null;
	podIP: string | null;
	port: number | null;
	syncUrl: string | null;
	ready: boolean;
	needsDapr: boolean;
	daprAppId: string | null;
	sandboxName: string | null;
	sessionId: string | null;
	sessionUrl: string | null;
	runStatus: string | null;
	createdAt: string;
}

type PreviewDetails = {
	kind?: string;
	service?: string;
	browseUrl?: string | null;
	podIP?: string | null;
	port?: number | null;
	syncUrl?: string | null;
	ready?: boolean;
	needsDapr?: boolean;
	daprAppId?: string | null;
	sandboxName?: string | null;
};

function detailsOf(sandboxState: unknown): PreviewDetails | null {
	const details = (sandboxState as { details?: PreviewDetails } | null)?.details;
	return details && typeof details === "object" ? details : null;
}

/** Reconstruct the human-browsable tailnet URL when an older row lacks it. */
function browseUrlFor(service: string, stored: string | null | undefined): string | null {
	if (stored) return stored;
	const d = DEV_PREVIEW_SERVICES[service];
	return d ? `http://${d.tailnetHost}` : null;
}

/** List active dev environments for a project, newest first. */
export async function listDevEnvironments(
	projectId: string | null | undefined,
): Promise<DevEnvironmentSummary[]> {
	if (!db || !projectId) return [];
	const rows = await db
		.select({
			workspaceRef: workflowWorkspaceSessions.workspaceRef,
			executionId: workflowWorkspaceSessions.workflowExecutionId,
			sandboxState: workflowWorkspaceSessions.sandboxState,
			createdAt: workflowWorkspaceSessions.createdAt,
			runStatus: workflowExecutions.status,
		})
		.from(workflowWorkspaceSessions)
		.innerJoin(
			workflowExecutions,
			eq(workflowExecutions.id, workflowWorkspaceSessions.workflowExecutionId),
		)
		// Scope by the WORKFLOW's project, not workflowExecutions.projectId — the
		// latter is nullable and the execute route doesn't always stamp it.
		.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.where(
			and(
				eq(workflows.projectId, projectId),
				eq(workflowWorkspaceSessions.status, "active"),
			),
		)
		.orderBy(desc(workflowWorkspaceSessions.createdAt));

	const previews = rows
		.map((row) => ({ row, details: detailsOf(row.sandboxState) }))
		.filter((x) => x.details?.kind === "dev-preview" && x.row.executionId);
	if (previews.length === 0) return [];

	// Resolve the bound interactive session per execution (one query).
	const execIds = [...new Set(previews.map((p) => p.row.executionId as string))];
	// execIds are already project-scoped (via the workflow join above), so match
	// the bound session by workflowExecutionId without re-filtering on
	// sessions.projectId (which can also be null).
	const sessionRows = execIds.length
		? await db
				.select({
					id: sessions.id,
					workflowExecutionId: sessions.workflowExecutionId,
					createdAt: sessions.createdAt,
				})
				.from(sessions)
				.where(inArray(sessions.workflowExecutionId, execIds))
				.orderBy(desc(sessions.createdAt))
		: [];
	const sessionByExec = new Map<string, string>();
	for (const s of sessionRows) {
		if (s.workflowExecutionId && !sessionByExec.has(s.workflowExecutionId)) {
			sessionByExec.set(s.workflowExecutionId, s.id);
		}
	}

	return previews.map(({ row, details }) => {
		const service = details?.service || "workflow-builder";
		const sessionId = sessionByExec.get(row.executionId as string) ?? null;
		return {
			executionId: row.executionId as string,
			workspaceRef: row.workspaceRef,
			service,
			browseUrl: browseUrlFor(service, details?.browseUrl),
			podIP: details?.podIP ?? null,
			port: details?.port ?? null,
			syncUrl: details?.syncUrl ?? null,
			ready: details?.ready === true,
			needsDapr: details?.needsDapr === true,
			daprAppId: details?.daprAppId ?? null,
			sandboxName: details?.sandboxName ?? null,
			sessionId,
			sessionUrl: sessionId ? `/sessions/${sessionId}` : null,
			runStatus: row.runStatus ?? null,
			createdAt: row.createdAt.toISOString(),
		};
	});
}

/** Single dev environment by execution id (project-scoped). */
export async function getDevEnvironment(
	executionId: string,
	projectId: string | null | undefined,
): Promise<DevEnvironmentSummary | null> {
	const all = await listDevEnvironments(projectId);
	return all.find((e) => e.executionId === executionId) ?? null;
}

const TERMINAL_RUN_STATUSES = new Set(["success", "error", "cancelled"]);

/**
 * Like getDevEnvironment but, when the preview row hasn't been persisted yet
 * (the run just started), returns a "provisioning" placeholder so the detail
 * page can poll instead of 404ing right after launch. Returns null only when the
 * run is gone, or terminal with no active preview (torn down / failed launch).
 */
export async function getDevEnvironmentOrPending(
	executionId: string,
	projectId: string | null | undefined,
): Promise<DevEnvironmentSummary | null> {
	const found = await getDevEnvironment(executionId, projectId);
	if (found) return found;
	if (!db || !projectId) return null;

	const [exec] = await db
		.select({
			id: workflowExecutions.id,
			status: workflowExecutions.status,
			input: workflowExecutions.input,
			createdAt: workflowExecutions.startedAt,
		})
		.from(workflowExecutions)
		// Scope by the workflow's project (executions.projectId is nullable).
		.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
		.where(
			and(
				eq(workflowExecutions.id, executionId),
				eq(workflows.projectId, projectId),
			),
		)
		.limit(1);
	// No run, or a terminal run with no active preview → truly gone.
	if (!exec || TERMINAL_RUN_STATUSES.has(exec.status)) return null;

	const service =
		(exec.input?.service as string | undefined) || "workflow-builder";
	const [boundSession] = await db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.workflowExecutionId, executionId))
		.orderBy(desc(sessions.createdAt))
		.limit(1);
	const d = DEV_PREVIEW_SERVICES[service];
	return {
		executionId,
		workspaceRef: "",
		service,
		browseUrl: browseUrlFor(service, null),
		podIP: null,
		port: d?.port ?? null,
		syncUrl: null,
		ready: false,
		needsDapr: d?.needsDapr === true,
		daprAppId: null,
		sandboxName: null,
		sessionId: boundSession?.id ?? null,
		sessionUrl: boundSession?.id ? `/sessions/${boundSession.id}` : null,
		runStatus: exec.status,
		createdAt: exec.createdAt.toISOString(),
	};
}

/**
 * The orchestrator calls the BFF internal dev/* + session/* routes with its
 * DAPR INSTANCE id (`sw-<wf>-exec-<id>`), not the canonical `workflow_executions.id`.
 * Resolve either form to the canonical id so the dev-preview row's FK holds and
 * the bound session attaches to the row the Dev hub queries. Falls back to the
 * input when no row matches (e.g. ad-hoc verification ids).
 */
export async function resolveCanonicalExecutionId(
	idOrInstanceId: string,
): Promise<string> {
	if (!db || !idOrInstanceId) return idOrInstanceId;
	const [row] = await db
		.select({ id: workflowExecutions.id })
		.from(workflowExecutions)
		.where(
			or(
				eq(workflowExecutions.id, idOrInstanceId),
				eq(workflowExecutions.daprInstanceId, idOrInstanceId),
			),
		)
		.limit(1);
	return row?.id ?? idOrInstanceId;
}

/** Public, credential-free catalog of launchable services for the UI dropdown. */
export function devPreviewServiceCatalog() {
	return Object.values(DEV_PREVIEW_SERVICES).map((d) => ({
		service: d.service,
		needsDapr: d.needsDapr === true,
		port: d.port,
		syncMode: d.syncMode,
		repoUrl: d.repoUrl,
		repoSubdir: d.repoSubdir,
		tailnetHost: d.tailnetHost,
	}));
}

export { resolveDevPreviewDescriptor };
