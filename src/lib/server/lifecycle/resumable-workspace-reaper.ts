/**
 * Abandoned-resumable-workspace reaper.
 *
 * Resumable workflows (`x-workflow-builder.resumable: true`) retain their JuiceFS
 * `/sandbox/work` on ANY terminal state so completed runs can be forked. Never-forked
 * ones leak data. The orchestrator records each retained workspace as a
 * `workflow_workspace_sessions` row (backend='juicefs', status='active'); this reaper
 * finds the abandoned ones (terminal + aged + not superseded by an active fork) and
 * reclaims the JuiceFS subPath data via the sandbox-execution-api purge endpoint, then
 * marks the row `cleaned`.
 *
 * Driven by the stacks `resumable-workspace-gc` CronJob → POST
 * /api/internal/lifecycle/reap-resumable-workspaces. Destructive, so gated strictly +
 * idempotent.
 */
import { and, eq, inArray, lt, notExists, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { env } from "$env/dynamic/private";
import { db } from "$lib/server/db";
import { workflowExecutions, workflowWorkspaceSessions } from "$lib/server/db/schema";

const TERMINAL: Array<"success" | "error" | "cancelled"> = [
	"success",
	"error",
	"cancelled",
];

function sandboxExecutionApiUrl(): string | null {
	const raw = env.SANDBOX_EXECUTION_API_URL ?? process.env.SANDBOX_EXECUTION_API_URL ?? "";
	return raw ? raw.replace(/\/$/, "") : null;
}

export interface ReapResumableResult {
	scanned: number;
	cleaned: number;
	skipped: number;
	errors: Array<{ workspaceRef: string; error: string }>;
	dryRun: boolean;
}

export async function reapResumableWorkspaces(
	opts: { olderThanHours?: number; limit?: number; dryRun?: boolean } = {},
): Promise<ReapResumableResult> {
	const result: ReapResumableResult = {
		scanned: 0,
		cleaned: 0,
		skipped: 0,
		errors: [],
		dryRun: Boolean(opts.dryRun),
	};
	if (!db) return result;

	const olderThanHours = opts.olderThanHours ?? 24;
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	const cutoff = new Date(Date.now() - olderThanHours * 3600_000);

	// Candidate retained juicefs workspaces whose owning run is terminal + aged, and
	// which have NOT been superseded by a still-running fork child (rerun lineage).
	const child = alias(workflowExecutions, "fork_child");
	const candidates = await db
		.select({
			workspaceRef: workflowWorkspaceSessions.workspaceRef,
			executionId: workflowWorkspaceSessions.workflowExecutionId,
		})
		.from(workflowWorkspaceSessions)
		.innerJoin(
			workflowExecutions,
			eq(workflowExecutions.id, workflowWorkspaceSessions.workflowExecutionId),
		)
		.where(
			and(
				eq(workflowWorkspaceSessions.status, "active"),
				eq(workflowWorkspaceSessions.backend, "juicefs"),
				inArray(workflowExecutions.status, TERMINAL),
				lt(workflowExecutions.completedAt, cutoff),
				// No active fork child still using this workspace.
				notExists(
					db
						.select({ one: sql`1` })
						.from(child)
						.where(
							and(
								eq(child.rerunOfExecutionId, workflowExecutions.id),
								notInArray(child.status, TERMINAL),
							),
						),
				),
			),
		)
		.limit(limit);

	result.scanned = candidates.length;
	if (candidates.length === 0) return result;

	const baseUrl = sandboxExecutionApiUrl();
	const token = env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";

	for (const row of candidates) {
		const workspaceRef = row.workspaceRef;
		if (opts.dryRun) {
			result.skipped++;
			continue;
		}
		try {
			if (baseUrl) {
				const res = await fetch(`${baseUrl}/internal/workspace/purge-data`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(token ? { Authorization: `Bearer ${token}` } : {}),
					},
					body: JSON.stringify({ workspaceExecutionId: workspaceRef }),
					signal: AbortSignal.timeout(20_000),
				});
				if (!res.ok && res.status !== 404) {
					throw new Error(`purge-data HTTP ${res.status}`);
				}
			}
			await db
				.update(workflowWorkspaceSessions)
				.set({ status: "cleaned", cleanedAt: new Date(), updatedAt: new Date() })
				.where(eq(workflowWorkspaceSessions.workspaceRef, workspaceRef));
			result.cleaned++;
		} catch (err) {
			result.errors.push({
				workspaceRef,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return result;
}
