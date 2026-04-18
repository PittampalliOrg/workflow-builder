import { error } from "@sveltejs/kit";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { PageServerLoad } from "./$types";
import { db } from "$lib/server/db";
import { workflowExecutions, workflows } from "$lib/server/db/schema";

export type WorkspaceWorkflowRow = {
	id: string;
	name: string;
	updatedAt: string;
	latestExecution: {
		id: string;
		status: string;
		startedAt: string;
		completedAt: string | null;
	} | null;
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

	// Batch-load each workflow's latest execution. For ~100 workflows this is
	// a single correlated subquery; for now do a simple per-row lookup since
	// the list is capped at 100.
	const results: WorkspaceWorkflowRow[] = [];
	for (const row of rows) {
		const [latest] = await db
			.select({
				id: workflowExecutions.id,
				status: workflowExecutions.status,
				startedAt: workflowExecutions.startedAt,
				completedAt: workflowExecutions.completedAt,
			})
			.from(workflowExecutions)
			.where(eq(workflowExecutions.workflowId, row.id))
			.orderBy(desc(workflowExecutions.startedAt))
			.limit(1);
		results.push({
			id: row.id,
			name: row.name,
			updatedAt: row.updatedAt.toISOString(),
			latestExecution: latest
				? {
						id: latest.id,
						status: latest.status,
						startedAt: latest.startedAt.toISOString(),
						completedAt: latest.completedAt?.toISOString() ?? null,
					}
				: null,
		});
	}

	return { slug: params.slug, workflows: results };
};
