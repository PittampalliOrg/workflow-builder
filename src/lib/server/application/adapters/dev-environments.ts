import { and, desc, eq, inArray, or } from "drizzle-orm";
import { db as defaultDb } from "$lib/server/db";
import {
	sessions,
	workflowExecutions,
	workflows,
	workflowWorkspaceSessions,
} from "$lib/server/db/schema";
import { requirePostgresDb } from "$lib/server/application/adapters/postgres";
import type {
	DevEnvironmentReadRepository,
	DevEnvironmentSummaryReadModel,
	DevPreviewServiceReadModel,
} from "$lib/server/application/ports";
import {
	browseUrlFor,
	detailsOf,
	devPreviewServiceCatalog,
} from "$lib/server/workflows/dev-environments";
import { DEV_PREVIEW_SERVICES } from "$lib/server/workflows/dev-preview-registry";

type Database = typeof defaultDb;

const TERMINAL_RUN_STATUSES = new Set(["success", "error", "cancelled"]);

function devPreviewServiceFromInput(input: unknown): string {
	if (!input || typeof input !== "object") return "workflow-builder";
	const service = (input as { service?: unknown }).service;
	return typeof service === "string" && service ? service : "workflow-builder";
}

export class PostgresDevEnvironmentReadRepository
	implements DevEnvironmentReadRepository
{
	constructor(private readonly database: Database = requirePostgresDb()) {}

	listServices(): DevPreviewServiceReadModel[] {
		return devPreviewServiceCatalog();
	}

	/** List active dev environments for a project, newest first. */
	async listDevEnvironments(
		projectId: string | null | undefined,
	): Promise<DevEnvironmentSummaryReadModel[]> {
		if (!projectId) return [];
		const rows = await this.database
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
			// Scope by the WORKFLOW's project, not workflowExecutions.projectId; the
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

		// Resolve the bound interactive session per execution in one query.
		const execIds = [...new Set(previews.map((p) => p.row.executionId as string))];
		// execIds are already project-scoped via the workflow join, so match the
		// bound session without re-filtering on sessions.projectId, which can be null.
		const sessionRows = execIds.length
			? await this.database
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

	async getDevEnvironmentOrPending(input: {
		executionId: string;
		projectId: string | null | undefined;
	}): Promise<DevEnvironmentSummaryReadModel | null> {
		const found = await this.getDevEnvironment(input.executionId, input.projectId);
		if (found) return found;
		if (!input.projectId) return null;

		const [exec] = await this.database
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				input: workflowExecutions.input,
				createdAt: workflowExecutions.startedAt,
			})
			.from(workflowExecutions)
			// Scope by the workflow's project; executions.projectId is nullable.
			.innerJoin(workflows, eq(workflows.id, workflowExecutions.workflowId))
			.where(
				and(
					eq(workflowExecutions.id, input.executionId),
					eq(workflows.projectId, input.projectId),
				),
			)
			.limit(1);
		// No run, or a terminal run with no active preview, means it is truly gone.
		if (!exec || TERMINAL_RUN_STATUSES.has(exec.status)) return null;

		const service = devPreviewServiceFromInput(exec.input);
		const [boundSession] = await this.database
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.workflowExecutionId, input.executionId))
			.orderBy(desc(sessions.createdAt))
			.limit(1);
		const d = DEV_PREVIEW_SERVICES[service];
		return {
			executionId: input.executionId,
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
	 * The orchestrator calls internal dev/* + session/* routes with its Dapr
	 * instance id (`sw-<wf>-exec-<id>`), not the canonical workflow execution id.
	 * Resolve either form so preview rows satisfy the FK and the Dev hub can find
	 * them. Fall back to the input for ad-hoc verification ids.
	 */
	async resolveCanonicalExecutionId(input: { executionId: string }): Promise<string> {
		const idOrInstanceId = input.executionId;
		if (!idOrInstanceId) return idOrInstanceId;
		const [row] = await this.database
			.select({ id: workflowExecutions.id })
			.from(workflowExecutions)
			.where(
				or(
					eq(workflowExecutions.id, idOrInstanceId),
					eq(workflowExecutions.daprInstanceId, idOrInstanceId),
				),
			)
			.limit(1);
		if (row?.id) return row.id;
		// Backstop for the dispatch race: dapr_instance_id is stamped after dispatch,
		// but the orchestrator can call these routes first with deterministic
		// `sw-<workflowId>-exec-<execId>`. Strip the last `-exec-` and verify by id.
		const m = idOrInstanceId.match(/^sw-.+-exec-(.+)$/);
		if (m?.[1]) {
			const suffix = m[1];
			const [byId] = await this.database
				.select({ id: workflowExecutions.id })
				.from(workflowExecutions)
				.where(eq(workflowExecutions.id, suffix))
				.limit(1);
			return byId?.id ?? suffix;
		}
		return idOrInstanceId;
	}

	private async getDevEnvironment(
		executionId: string,
		projectId: string | null | undefined,
	): Promise<DevEnvironmentSummaryReadModel | null> {
		const all = await this.listDevEnvironments(projectId);
		return all.find((e) => e.executionId === executionId) ?? null;
	}
}
