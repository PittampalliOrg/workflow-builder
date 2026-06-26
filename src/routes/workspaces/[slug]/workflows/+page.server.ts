import { error } from "@sveltejs/kit";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { PageServerLoad } from "./$types";
import { db } from "$lib/server/db";
import { workflowExecutions, workflows } from "$lib/server/db/schema";

export type WorkspaceWorkflowRun = {
	id: string;
	status: string;
	startedAt: string;
	completedAt: string | null;
};

export type WorkspaceWorkflowRow = {
	id: string;
	name: string;
	updatedAt: string;
	latestExecution: WorkspaceWorkflowRun | null;
	/** Last 3 executions, newest first. Drives the activity-dots column. */
	recentRuns: WorkspaceWorkflowRun[];
	/** True when the latest execution is still running/pending. */
	running: boolean;
	/** Most recent of (edited, last run) — the sort + "last active" key. */
	lastActivityAt: string;
};

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!db) throw error(503, "Database not configured");
	if (!locals.session?.userId) throw error(401, "Authentication required");

	const projectId = locals.session.projectId ?? null;

	// Workflows for this workspace: either stamped with this project_id, or
	// pre-CMA workflows (null project_id) owned by the current user.
	const rows = await db
		.select({
			id: workflows.id,
			name: workflows.name,
			updatedAt: workflows.updatedAt,
		})
		.from(workflows)
		.where(
			projectId
				? or(
						eq(workflows.projectId, projectId),
						and(
							isNull(workflows.projectId),
							eq(workflows.userId, locals.session.userId),
						),
					)
				: eq(workflows.userId, locals.session.userId),
		)
		.orderBy(desc(workflows.updatedAt))
		.limit(100);

	if (rows.length === 0) {
		return { slug: params.slug, workflows: [] as WorkspaceWorkflowRow[] };
	}

	// Fetch the last 3 executions per workflow to power both the "Latest run"
	// column and the activity-dots column. Per-workflow loop is fine for the
	// 100-workflow cap; a window-function rewrite is easy if we hit scale.
	const results: WorkspaceWorkflowRow[] = [];
	for (const row of rows) {
		const recentRaw = await db
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.workflowId, row.id))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(3);
		const recentRuns: WorkspaceWorkflowRun[] = recentRaw.map((e) => ({
			id: e.id,
			status: e.status,
			startedAt: e.startedAt.toISOString(),
			completedAt: e.completedAt?.toISOString() ?? null,
		}));
		const latest = recentRuns[0] ?? null;
		const updatedAtIso = row.updatedAt.toISOString();
		const running =
			latest?.status === "running" || latest?.status === "pending";
		// "Last active" = the more recent of edit-time and the latest run. Runs differ
		// per workflow, so this is meaningful even when a seed/sync set every
		// `updatedAt` to the same instant.
		const lastActivityAt =
			latest && latest.startedAt > updatedAtIso ? latest.startedAt : updatedAtIso;
		results.push({
			id: row.id,
			name: row.name,
			updatedAt: updatedAtIso,
			latestExecution: latest,
			recentRuns,
			running,
			lastActivityAt,
		});
	}

	// Surface what matters first: running workflows, then most-recently-active.
	// (The initial query ordered by updatedAt only to bound the 100-row window.)
	results.sort((a, b) => {
		if (a.running !== b.running) return a.running ? -1 : 1;
		return b.lastActivityAt.localeCompare(a.lastActivityAt);
	});

	return { slug: params.slug, workflows: results };
};
